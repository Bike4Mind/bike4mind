/**
 * Data-lake connector orphan reaper.
 *
 * A Drive connection holds a globally unique claim on its driveFolderId, and a GitHub binding one on its
 * repositoryId. The lake purge (cleanupDeletedDataLake, run by the dataLakeCleanup queue handler)
 * releases the connection before deleting the lake, but a row can still outlive its lake document
 * (a purge from before that step existed, a race). Nothing else retires such a row: the ingest handler
 * only reaches it when the scheduled poll picks it, and the poll skips disabled and unhealthy rows. So
 * the folder or repo stays claimed by a lake nobody can reach. This sweep finds rows whose lake document
 * is gone and tears them down through the same release helpers the purge uses.
 *
 * A soft-deleted lake keeps its document, so its connection is NOT an orphan: the purge owns that one.
 *
 * Gated on EnableDataLakes only, not on the poll/reconcile opt-ins: cleanup must run even with polling
 * off. The GitHub leg additionally needs EnableDataLakeGitHub, since releasing the last binding of an
 * installation calls the GitHub API.
 *
 * Schedule: daily. Capped per connector per run; a failed release is logged and retried next run.
 */

import {
  adminSettingsRepository,
  connectDB,
  orgGitHubLakeConnectionRepository,
  orgGoogleDriveConnectionRepository,
} from '@bike4mind/database';
import { driveConnectionOwnerOf } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { releaseDriveConnection } from '@server/integrations/google/drive/common';
import { releaseGitHubLakeConnection } from '@server/integrations/github/dataLake/githubLakeConnection';
import { getGitHubLakeAppConfig } from '@server/integrations/github/dataLake/lakeAppClient';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'lakeConnectorOrphanReap' } });

export const MAX_REAPS_PER_CONNECTOR = 100;

export type ConnectorReapResult = { found: number; released: number; failed: number; skipped?: true };

export type LakeConnectorOrphanReapResult = {
  drive: ConnectorReapResult;
  github: ConnectorReapResult;
  disabled?: true;
};

const emptyResult = (): ConnectorReapResult => ({ found: 0, released: 0, failed: 0 });

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Sequential on purpose: a daily run over a handful of rows gains nothing from a burst against Google/GitHub. */
async function reapEach<T extends { id: string }>(
  connector: 'drive' | 'github',
  orphans: readonly T[],
  release: (orphan: T) => Promise<unknown>
): Promise<ConnectorReapResult> {
  const result: ConnectorReapResult = { ...emptyResult(), found: orphans.length };
  for (const orphan of orphans) {
    const connectionId = String(orphan.id);
    try {
      await release(orphan);
      result.released += 1;
    } catch (e) {
      result.failed += 1;
      logger.error('[lakeConnectorOrphanReap] failed to release an orphaned connection', {
        connector,
        connectionId,
        error: errorMessage(e),
      });
    }
  }
  return result;
}

async function reapDrive(): Promise<ConnectorReapResult> {
  const orphans = await orgGoogleDriveConnectionRepository.findOrphaned(MAX_REAPS_PER_CONNECTOR);
  return reapEach('drive', orphans, async connection => {
    // false means no row matched: a concurrent purge or ingest already retired it, which is the goal.
    await releaseDriveConnection(connection.id, driveConnectionOwnerOf(connection));
  });
}

async function reapGitHub(): Promise<ConnectorReapResult> {
  const orphans = await orgGitHubLakeConnectionRepository.findOrphaned(MAX_REAPS_PER_CONNECTOR);
  // An absent App config throws only for an installation's last binding (it must delete the
  // installation); that row is counted as failed and retried once the App is configured.
  const config = getGitHubLakeAppConfig();
  return reapEach('github', orphans, connection => releaseGitHubLakeConnection(connection, config));
}

export async function runLakeConnectorOrphanReap(): Promise<LakeConnectorOrphanReapResult> {
  const [lakesOn, githubOn] = await Promise.all([
    adminSettingsRepository.getSettingsValue('EnableDataLakes'),
    adminSettingsRepository.getSettingsValue('EnableDataLakeGitHub'),
  ]);
  if (!lakesOn) {
    logger.info('[lakeConnectorOrphanReap] EnableDataLakes is off; skipping');
    return { drive: emptyResult(), github: emptyResult(), disabled: true };
  }

  // Each leg's scan is guarded too, so one connector's failing query cannot hide the other's orphans.
  const scanFailed = (connector: 'drive' | 'github') => (e: unknown) => {
    logger.error('[lakeConnectorOrphanReap] orphan scan failed', { connector, error: errorMessage(e) });
    return { ...emptyResult(), failed: 1 };
  };

  const drive = await reapDrive().catch(scanFailed('drive'));

  let github: ConnectorReapResult;
  if (githubOn) {
    github = await reapGitHub().catch(scanFailed('github'));
  } else {
    logger.info('[lakeConnectorOrphanReap] EnableDataLakeGitHub is off; skipping the GitHub leg');
    github = { ...emptyResult(), skipped: true };
  }

  // Logged even at zero: this line is the operator's orphan count.
  logger.info('[lakeConnectorOrphanReap] sweep complete', { drive, github });
  return { drive, github };
}

export async function handler() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await runLakeConnectorOrphanReap();
  return { statusCode: 200, body: JSON.stringify(result) };
}

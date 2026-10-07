/**
 * GitHub-as-lake scheduled reconcile.
 *
 * Backstop for the push webhook: a delivery GitHub never sent, or one the ingest handler dropped after
 * exhausting its redrives, leaves the lake behind the repository with nothing to bring it forward. Each
 * run compares every due connection's default-branch HEAD with its lastSyncedCommitSha and, when they
 * differ, enqueues the same githubLakeIngest message a push would. The handler's claimForSync
 * serializes it against a webhook or manual Re-sync already running.
 *
 * Dark by default: gated on EnableDataLakes AND EnableDataLakeGitHub AND EnableDataLakeGitHubReconcile.
 * Capped per run; findDueForReconcile is oldest-checked-first, so a large fleet drains across runs.
 */

import { adminSettingsRepository, connectDB, orgGitHubLakeConnectionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { sendToQueue } from '@server/utils/sqs';
import {
  getBranchHeadSha,
  getGitHubLakeAppConfig,
  getInstallationOctokit,
  getRepository,
  gitHubErrorStatus,
  gitHubRateLimitDelaySeconds,
} from '@server/integrations/github/dataLake/lakeAppClient';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'githubLakeReconcile' } });

export const MAX_CHECKS_PER_RUN = 200;

// Each check is up to three GitHub calls; a modest window keeps one installation's budget from
// draining in a burst while still finishing MAX_CHECKS_PER_RUN well inside the cron's timeout.
const CHECK_CONCURRENCY = 10;

export type GitHubLakeReconcileResult = {
  checked: number;
  enqueued: number;
  unchanged: number;
  skipped: number;
  failed: number;
  throttledInstallations: number;
  disabled?: true;
};

type Outcome = 'enqueued' | 'unchanged' | 'skipped' | 'failed' | 'throttled';

const emptyResult = (): GitHubLakeReconcileResult => ({
  checked: 0,
  enqueued: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  throttledInstallations: 0,
});

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runGitHubLakeReconcile({ now = Date.now() }: { now?: number } = {}) {
  const flags = {
    lakes: !!(await adminSettingsRepository.getSettingsValue('EnableDataLakes')),
    github: !!(await adminSettingsRepository.getSettingsValue('EnableDataLakeGitHub')),
    reconcile: !!(await adminSettingsRepository.getSettingsValue('EnableDataLakeGitHubReconcile')),
  };
  if (!flags.lakes || !flags.github || !flags.reconcile) {
    logger.info('[githubLakeReconcile] disabled; skipping', flags);
    return { ...emptyResult(), disabled: true as const };
  }

  const config = getGitHubLakeAppConfig();
  if (!config) {
    logger.warn('[githubLakeReconcile] GitHub lake App is not configured; skipping');
    return emptyResult();
  }

  const due = await orgGitHubLakeConnectionRepository.findDueForReconcile(MAX_CHECKS_PER_RUN);
  // A throttled installation's remaining connections are left for the next run instead of burning
  // calls against an exhausted budget; they stay unstamped, so they lead the next batch.
  const throttled = new Set<number>();

  const enqueue = async (connectionId: string): Promise<Outcome> => {
    try {
      await sendToQueue(Resource.githubLakeIngestQueue.url, { connectionId, manual: false });
      return 'enqueued';
    } catch (e) {
      logger.error('[githubLakeReconcile] failed to enqueue connection', { connectionId, error: errorMessage(e) });
      return 'failed';
    }
  };

  const checkOne = async (conn: (typeof due)[number]): Promise<Outcome> => {
    const connectionId = String(conn.id);
    if (throttled.has(conn.installationId)) return 'throttled';
    let stage: 'token' | 'repository' | 'branch' = 'token';
    let head: string;
    try {
      const octokit = await getInstallationOctokit(config, conn.installationId, conn.repositoryId);
      stage = 'repository';
      const repo = await getRepository(octokit, conn.repositoryFullName, conn.repositoryId);
      stage = 'branch';
      head = await getBranchHeadSha(octokit, repo.fullName, repo.defaultBranch);
    } catch (e) {
      if (gitHubRateLimitDelaySeconds(e, now) !== null) {
        throttled.add(conn.installationId);
        return 'throttled';
      }
      const status = gitHubErrorStatus(e);
      // A repo with no commits has no default branch to read yet.
      if (stage === 'branch' && status === 404) return 'skipped';
      // The App lost the repository: let the ingest handler record that on the connection, which then
      // drops out of findDueForReconcile. This cron never writes status itself.
      if ((stage === 'token' && (status === 422 || status === 404)) || (stage === 'repository' && status === 404)) {
        logger.info('[githubLakeReconcile] repository no longer readable; enqueueing so the sync records it', {
          connectionId,
          status,
        });
        return enqueue(connectionId);
      }
      logger.error('[githubLakeReconcile] HEAD check failed', { connectionId, stage, status, error: errorMessage(e) });
      return 'failed';
    }
    if (head === conn.lastSyncedCommitSha) return 'unchanged';
    return enqueue(connectionId);
  };

  const result = emptyResult();
  const stampIds: string[] = [];
  for (let i = 0; i < due.length; i += CHECK_CONCURRENCY) {
    const window = due.slice(i, i + CHECK_CONCURRENCY);
    const outcomes = await Promise.all(
      window.map(conn =>
        checkOne(conn).catch(e => {
          logger.error('[githubLakeReconcile] check threw', { connectionId: String(conn.id), error: errorMessage(e) });
          return 'failed' as const;
        })
      )
    );
    outcomes.forEach((outcome, j) => {
      if (outcome === 'throttled') return;
      result[outcome] += 1;
      stampIds.push(String(window[j].id));
    });
  }
  result.checked = stampIds.length;
  result.throttledInstallations = throttled.size;

  try {
    await orgGitHubLakeConnectionRepository.markReconcileChecked(stampIds, new Date(now));
  } catch (e) {
    logger.error('[githubLakeReconcile] failed to stamp reconcileCheckedAt', { error: errorMessage(e) });
  }

  logger.info('[githubLakeReconcile] sweep complete', { due: due.length, ...result });
  return result;
}

export async function handler() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await runGitHubLakeReconcile();
  return { statusCode: 200, body: JSON.stringify(result) };
}

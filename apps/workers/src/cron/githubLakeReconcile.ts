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
 *
 * The ingest handler can release a sync without recording the commit (lake missing, user gone, storage
 * limit, transient error), so the same HEAD would compare as changed on every run. Each enqueue is
 * remembered on the connection, and the same target is not re-enqueued until RETRY_COOLDOWN_MS passes.
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

/** How long one target HEAD waits before the reconcile enqueues it again (a new HEAD is not held back). */
export const RETRY_COOLDOWN_MS = 6 * 60 * 60_000;

// No new window starts past this, leaving headroom under the cron's 5-minute Lambda timeout (infra/cron.ts).
export const RUN_BUDGET_MS = 4 * 60_000;

// Each check is up to three GitHub calls; a modest window keeps one installation's budget from
// draining in a burst; RUN_BUDGET_MS bounds the run as a whole.
const CHECK_CONCURRENCY = 10;

export type GitHubLakeReconcileResult = {
  checked: number;
  enqueued: number;
  unchanged: number;
  skipped: number;
  failed: number;
  /** Target already enqueued within RETRY_COOLDOWN_MS. */
  backoff: number;
  /** Left unchecked because the run budget ran out; they lead the next run. */
  notReached: number;
  throttledInstallations: number;
  disabled?: true;
};

type Outcome = 'enqueued' | 'unchanged' | 'skipped' | 'failed' | 'backoff' | 'throttled';

const emptyResult = (): GitHubLakeReconcileResult => ({
  checked: 0,
  enqueued: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  backoff: 0,
  notReached: 0,
  throttledInstallations: 0,
});

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runGitHubLakeReconcile({
  now = Date.now(),
  budgetMs = RUN_BUDGET_MS,
}: { now?: number; budgetMs?: number } = {}) {
  const startedAt = Date.now();
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
  // A throttled installation's remaining connections are left for a later run instead of burning calls
  // against an exhausted budget. They are still stamped, so one busy installation cannot hold the head of
  // every batch and starve the others.
  const throttled = new Set<number>();

  type DueConnection = (typeof due)[number];

  // target is the HEAD being synced, or null when access was lost before HEAD could be read.
  const enqueue = async (conn: DueConnection, target: string | null): Promise<Outcome> => {
    const connectionId = String(conn.id);
    const lastAt = conn.reconcileEnqueuedAt?.getTime();
    // A sync recorded since that enqueue means it did not stall, so a HEAD that moved back to the same
    // target (force-push, revert) is new work, not a retry.
    const syncedSince = lastAt !== undefined && (conn.lastSyncedAt?.getTime() ?? -Infinity) >= lastAt;
    if (
      lastAt !== undefined &&
      !syncedSince &&
      now - lastAt < RETRY_COOLDOWN_MS &&
      (conn.reconcileEnqueuedSha ?? null) === target
    ) {
      return 'backoff';
    }
    try {
      await sendToQueue(Resource.githubLakeIngestQueue.url, { connectionId, manual: false });
    } catch (e) {
      logger.error('[githubLakeReconcile] failed to enqueue connection', { connectionId, error: errorMessage(e) });
      return 'failed';
    }
    try {
      await orgGitHubLakeConnectionRepository.markReconcileEnqueued(connectionId, target, new Date(now));
    } catch (e) {
      logger.error('[githubLakeReconcile] failed to record the enqueue', { connectionId, error: errorMessage(e) });
    }
    return 'enqueued';
  };

  const checkOne = async (conn: DueConnection): Promise<Outcome> => {
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
      // Same lost-access test as githubLakeIngest's shedBeforeSlice: 404 or 422 at either stage.
      if (stage !== 'branch' && (status === 404 || status === 422)) {
        logger.info('[githubLakeReconcile] repository no longer readable; enqueueing so the sync records it', {
          connectionId,
          status,
        });
        return enqueue(conn, null);
      }
      logger.error('[githubLakeReconcile] HEAD check failed', { connectionId, stage, status, error: errorMessage(e) });
      return 'failed';
    }
    // A stale 'syncing' claim is enqueued even on an unchanged HEAD: the ingest's claimForSync takes the
    // stale claim over and releases it, and with HEAD unchanged no push will arrive to do that.
    if (head === conn.lastSyncedCommitSha && conn.status !== 'syncing') return 'unchanged';
    return enqueue(conn, head);
  };

  const result = emptyResult();
  for (let i = 0; i < due.length; i += CHECK_CONCURRENCY) {
    if (i > 0 && Date.now() - startedAt >= budgetMs) {
      result.notReached = due.length - i;
      break;
    }
    const window = due.slice(i, i + CHECK_CONCURRENCY);
    const outcomes = await Promise.all(
      window.map(conn =>
        checkOne(conn).catch(e => {
          logger.error('[githubLakeReconcile] check threw', { connectionId: String(conn.id), error: errorMessage(e) });
          return 'failed' as const;
        })
      )
    );
    outcomes.forEach(outcome => {
      if (outcome === 'throttled') return;
      result[outcome] += 1;
      result.checked += 1;
    });
    // Stamped per window so a run cut short by the Lambda timeout keeps the progress it made.
    try {
      await orgGitHubLakeConnectionRepository.markReconcileChecked(
        window.map(conn => String(conn.id)),
        new Date(now)
      );
    } catch (e) {
      logger.error('[githubLakeReconcile] failed to stamp reconcileCheckedAt', { error: errorMessage(e) });
    }
  }
  result.throttledInstallations = throttled.size;

  logger.info('[githubLakeReconcile] sweep complete', { due: due.length, ...result });
  return result;
}

export async function handler() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await runGitHubLakeReconcile();
  return { statusCode: 200, body: JSON.stringify(result) };
}

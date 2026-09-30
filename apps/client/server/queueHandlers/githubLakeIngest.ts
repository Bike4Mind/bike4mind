import {
  BATCH_NON_TERMINAL_STATUSES,
  isLakeIngestable,
  settingsMap,
  type IUserDocument,
  type SettingKey,
} from '@bike4mind/common';
import {
  User,
  adminSettingsRepository,
  dataLakeBatchRepository,
  dataLakeRepository,
  orgGitHubLakeConnectionRepository,
} from '@bike4mind/database';
import { getSettingByName } from '@bike4mind/utils';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { isSettingEnabled } from '@server/middlewares/featureFlag';
import { sendToQueue } from '@server/utils/sqs';
import {
  getBranchHeadSha,
  getGitHubLakeAppConfig,
  getInstallationOctokit,
  getRepository,
  gitHubErrorStatus,
  gitHubRateLimitDelaySeconds,
} from '@server/integrations/github/dataLake/lakeAppClient';
import { runGitHubLakeSlice } from '@server/queueHandlers/githubLakeSlice';
import { settleLakeIngestBatch } from '@server/queueHandlers/lakeIngestShared';
import { Resource } from 'sst';
import { z, ZodError } from 'zod';

export const MAX_GITHUB_LAKE_REDRIVES = 12;
const REDRIVE_DELAY_SECONDS = 90;
export const MAX_GITHUB_LAKE_SLICES = 20;
export const MAX_GITHUB_LAKE_DEFERRALS = 8;
export const GITHUB_LAKE_CHAIN_BUDGET_MS = 3 * 60 * 60 * 1000;
// Used when the host cannot report the Lambda's remaining time (tests, the self-host worker).
const DEFAULT_RUN_BUDGET_MS = 9 * 60_000;

export const GITHUB_LAKE_RECONNECT_MESSAGE =
  'The GitHub App can no longer read this repository (it was uninstalled, or the repository was removed from its selection). Reconnect the repository.';

const Payload = z
  .object({
    connectionId: z.string(),
    manual: z.boolean().default(false),
    redriveCount: z.number().int().min(0).default(0),
    deferCount: z.number().int().min(0).default(0),
    slice: z.number().int().min(0).default(0),
    commitSha: z.string().optional(),
    resumeBatchId: z.string().optional(),
    claimToken: z.string().optional(),
    // Epoch ms of the chain's first claim; the 3 h budget spans every slice and deferral.
    chainStartedAt: z.number().int().optional(),
  })
  .refine(p => !p.resumeBatchId || (p.commitSha !== undefined && p.claimToken !== undefined), {
    message: 'A continuation must carry its pinned commitSha and claimToken',
  });

const flagOn = async (key: SettingKey) =>
  isSettingEnabled(
    (await getSettingByName(key, { adminSettings: adminSettingsRepository })) ?? settingsMap[key]?.defaultValue
  );

/**
 * Ingests one GitHub repository's default branch into its lake. Claims the connection (Drive's CAS claim),
 * pins HEAD on the first slice, runs one slice (githubLakeSlice.ts), then finishes, refuses, or yields by
 * re-enqueueing itself with the claim renewed. Mirrors driveLakeIngest.ts minus its cursor and change feed.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  let connectionId: string | undefined;
  // The CAS token this run holds for the sync claim; undefined while it holds none or has handed it off.
  let claimToken: string | undefined;
  try {
    const payload = Payload.parse(JSON.parse(event.Records[0].body));
    const id = payload.connectionId;
    connectionId = id;
    const { manual, redriveCount, deferCount, slice } = payload;
    let resumeBatchId = payload.resumeBatchId;
    const chainStartedAt = payload.chainStartedAt ?? Date.now();
    logger.updateMetadata({ handler: 'githubLakeIngest', connectionId: id });

    const runStartedAt = Date.now();
    const remainingMs = () => {
      const reported = context?.getRemainingTimeInMillis?.();
      return typeof reported === 'number' && Number.isFinite(reported)
        ? reported
        : DEFAULT_RUN_BUDGET_MS - (Date.now() - runStartedAt);
    };
    const enqueue = (body: z.input<typeof Payload>, delaySeconds?: number) =>
      sendToQueue(Resource.githubLakeIngestQueue.url, body, delaySeconds);
    const release = async (lastError: string | null, status: 'connected' | 'error' = 'connected') => {
      if (!claimToken) return;
      const token = claimToken;
      claimToken = undefined;
      const released = await orgGitHubLakeConnectionRepository.releaseSyncClaim(id, token, lastError, status);
      if (!released) {
        logger.warn('[githubLakeIngest] claim was taken away before release; leaving the new owner alone', {
          connectionId: id,
        });
      }
    };

    const connection = await orgGitHubLakeConnectionRepository.findById(id);
    if (!connection) {
      logger.warn('[githubLakeIngest] connection not found; dropping', { connectionId: id });
      if (resumeBatchId) await settleLakeIngestBatch(resumeBatchId, logger);
      return;
    }
    // The slice echoes a prior batch id even when it rejected it (settled, or another lake's), so only a
    // live batch of this lake is settled or handed on.
    const ownBatchId = async (batchId: string | null | undefined): Promise<string | null> => {
      if (!batchId) return null;
      const batch = await dataLakeBatchRepository.findById(batchId);
      return batch &&
        batch.dataLakeId === connection.targetDataLakeId &&
        BATCH_NON_TERMINAL_STATUSES.includes(batch.status)
        ? batchId
        : null;
    };
    const settle = async (batchId: string | null | undefined) => {
      const owned = await ownBatchId(batchId);
      if (owned) await settleLakeIngestBatch(owned, logger);
    };
    // A drop must not heal an error state it did not resolve, nor clear a message it did not replace.
    const releaseUnchanged = () =>
      release(connection.lastError ?? null, connection.status === 'error' ? 'error' : 'connected');

    // claimForSync only claims an enabled connection; adopt reports it so a disabled chain ends at the gate below.
    let enabledAtClaim = true;
    if (resumeBatchId && payload.claimToken) {
      const adopted = await orgGitHubLakeConnectionRepository.adoptSyncClaim(id, resumeBatchId, payload.claimToken);
      claimToken = adopted?.token;
      enabledAtClaim = adopted?.enabled ?? true;
    }
    // A pin is only trusted on an adopted claim: a fresh claim may follow a sync that recorded a newer commit,
    // and diffing at the stale pin would roll the lake back.
    const pinnedCommitSha = claimToken ? payload.commitSha : undefined;
    const adoptedClaim = Boolean(claimToken);
    if (!claimToken) {
      claimToken = (await orgGitHubLakeConnectionRepository.claimForSync(id)) ?? undefined;
    }
    if (!claimToken) {
      const current = await orgGitHubLakeConnectionRepository.findById(id);
      // claimForSync refuses a disabled connection (disconnect or archive), so waiting it out is pointless.
      if (current?.status === 'syncing' && current.enabled !== false && redriveCount < MAX_GITHUB_LAKE_REDRIVES) {
        // The whole payload rides along: a continuation that came back without its commit or batch would restart the chain.
        await enqueue({ ...payload, chainStartedAt, redriveCount: redriveCount + 1 }, REDRIVE_DELAY_SECONDS);
        logger.info('[githubLakeIngest] another sync in flight; deferred', {
          connectionId: id,
          redriveCount: redriveCount + 1,
        });
      } else {
        logger.info('[githubLakeIngest] could not claim; dropping', {
          connectionId: id,
          status: current?.status,
          redriveCount,
        });
      }
      return;
    }
    if (resumeBatchId && !adoptedClaim) {
      // No live chain owns the old batch once claimForSync wins; settle it so a path it skipped at
      // the stale commit isn't skipped again once this run diffs at the new HEAD.
      await settle(resumeBatchId);
      resumeBatchId = undefined;
    }

    // Guards the outer dispatch, not just yieldChain's own capRefusal check after a slice runs: a
    // continuation enqueued near the end of the window (a rate-limit deferral's delaySeconds runs up
    // to 900 s) would otherwise run a full slice of repo IO before capRefusal ever sees the budget
    // was exhausted.
    if (Date.now() - chainStartedAt > GITHUB_LAKE_CHAIN_BUDGET_MS) {
      logger.warn('[githubLakeIngest] chain budget already exhausted at dispatch; stopping', { connectionId: id });
      await settle(resumeBatchId);
      await release('Sync ran past its 3-hour budget before it finished. Re-sync to continue.');
      return;
    }

    // Gated after the claim so a continuation's chain claim is released rather than left to go stale.
    const featureOn = (await flagOn('EnableDataLakes')) && (await flagOn('EnableDataLakeGitHub'));
    const lake = await dataLakeRepository.findById(connection.targetDataLakeId);
    const dropReason = !featureOn
      ? 'feature_disabled'
      : !enabledAtClaim
        ? 'connection_disabled'
        : !lake
          ? 'lake_not_found'
          : !isLakeIngestable(lake.status)
            ? 'lake_not_ingestable'
            : null;
    if (dropReason !== null || !lake) {
      logger.info('[githubLakeIngest] not syncable; dropping', {
        connectionId: id,
        reason: dropReason,
        lakeStatus: lake?.status,
      });
      await settle(resumeBatchId);
      await releaseUnchanged();
      return;
    }
    // Same cast as driveLakeIngest: the hydrated document carries every IUserDocument field.
    const user = (await User.findById(connection.connectedBy)) as unknown as IUserDocument | null;
    if (!user) {
      logger.warn('[githubLakeIngest] connecting user not found; dropping', { connectionId: id });
      await settle(resumeBatchId);
      await releaseUnchanged();
      return;
    }
    const config = getGitHubLakeAppConfig();
    if (!config) {
      await settle(resumeBatchId);
      await release('The data-lake GitHub App is not configured on this deployment.');
      return;
    }

    const capRefusal = (nextSlice: number, nextDeferCount: number): string | null => {
      if (nextSlice >= MAX_GITHUB_LAKE_SLICES) {
        return `Sync stopped after ${MAX_GITHUB_LAKE_SLICES} continuation runs before it finished. Re-sync to continue.`;
      }
      if (nextDeferCount > MAX_GITHUB_LAKE_DEFERRALS) {
        return `GitHub rate-limited this sync ${MAX_GITHUB_LAKE_DEFERRALS} times and it stopped before it finished. Re-sync later.`;
      }
      if (Date.now() - chainStartedAt > GITHUB_LAKE_CHAIN_BUDGET_MS) {
        return 'Sync ran past its 3-hour budget before it finished. Re-sync to continue.';
      }
      return null;
    };

    // Re-enqueue the next step of the chain: renewed and handed off when it holds a batch, otherwise
    // released and re-claimed fresh. Either way the slice/deferral/budget counters ride along.
    const yieldChain = async (
      batchId: string | null | undefined,
      next: { slice: number; deferCount: number; commitSha?: string; delaySeconds?: number; remaining?: number }
    ) => {
      const heldBatchId = await ownBatchId(batchId);
      const refusal = capRefusal(next.slice, next.deferCount);
      if (refusal) {
        logger.warn('[githubLakeIngest] chain cap reached; stopping', { connectionId: id, ...next });
        if (heldBatchId) await settleLakeIngestBatch(heldBatchId, logger);
        await release(refusal);
        return;
      }
      const body = {
        connectionId: id,
        manual,
        slice: next.slice,
        deferCount: next.deferCount,
        chainStartedAt,
      };
      if (!heldBatchId || !next.commitSha) {
        // A batch without a trusted pin cannot be handed on; the fresh run starts its own.
        if (heldBatchId) await settleLakeIngestBatch(heldBatchId, logger);
        await release(null);
        await enqueue(body, next.delaySeconds);
        logger.info('[githubLakeIngest] released and re-enqueued fresh', { connectionId: id, ...next });
        return;
      }
      const renewed = claimToken
        ? await orgGitHubLakeConnectionRepository.renewSyncClaim(id, heldBatchId, claimToken)
        : null;
      if (!renewed) {
        logger.warn('[githubLakeIngest] lost the sync claim mid-slice; ending the chain', {
          connectionId: id,
          batchId: heldBatchId,
        });
        await settleLakeIngestBatch(heldBatchId, logger);
        await release('Sync stopped before it finished. Re-sync to continue.');
        return;
      }
      // Hold the rotated token before the enqueue can throw, so the catch releases the claim this run actually holds.
      claimToken = renewed;
      await enqueue(
        { ...body, commitSha: next.commitSha, resumeBatchId: heldBatchId, claimToken: renewed },
        next.delaySeconds
      );
      claimToken = undefined;
      logger.info('[githubLakeIngest] enqueued continuation', { connectionId: id, batchId: heldBatchId, ...next });
    };

    // Returns true when the error was a throttle or a lost-access status and has been handled.
    const shedBeforeSlice = async (error: unknown): Promise<boolean> => {
      const delaySeconds = gitHubRateLimitDelaySeconds(error, Date.now());
      if (delaySeconds !== null) {
        await yieldChain(resumeBatchId, {
          slice,
          deferCount: deferCount + 1,
          commitSha: pinnedCommitSha,
          delaySeconds,
        });
        return true;
      }
      const status = gitHubErrorStatus(error);
      // 422 is what the repo-scoped token mint returns once the repository leaves the installation's selection.
      if (status === 404 || status === 422) {
        await settle(resumeBatchId);
        await release(GITHUB_LAKE_RECONNECT_MESSAGE, 'error');
        return true;
      }
      return false;
    };

    let octokit: Awaited<ReturnType<typeof getInstallationOctokit>>;
    let gitHubRepo: Awaited<ReturnType<typeof getRepository>>;
    try {
      octokit = await getInstallationOctokit(config, connection.installationId, connection.repositoryId);
      gitHubRepo = await getRepository(octokit, connection.repositoryFullName, connection.repositoryId);
    } catch (error) {
      if (await shedBeforeSlice(error)) return;
      throw error;
    }

    let commitSha = pinnedCommitSha;
    if (!commitSha) {
      try {
        commitSha = await getBranchHeadSha(octokit, gitHubRepo.fullName, gitHubRepo.defaultBranch);
      } catch (error) {
        // An empty repository has no branch yet; that is not the App losing access.
        if (gitHubErrorStatus(error) === 404) {
          await release(`The default branch "${gitHubRepo.defaultBranch}" has no commits to sync yet.`);
          return;
        }
        if (await shedBeforeSlice(error)) return;
        throw error;
      }
      if (!manual && commitSha === connection.lastSyncedCommitSha) {
        logger.info('[githubLakeIngest] HEAD unchanged since the last sync; nothing to do', {
          connectionId: id,
          commitSha,
        });
        await releaseUnchanged();
        return;
      }
    }

    const outcome = await runGitHubLakeSlice({
      octokit,
      repoFullName: gitHubRepo.fullName,
      commitSha,
      connection,
      lake,
      user,
      resumeBatchId,
      remainingMs,
      logger,
    });

    if (outcome.kind === 'refused') {
      logger.warn('[githubLakeIngest] sync refused', { connectionId: id, reason: outcome.message });
      await settle(outcome.batchId);
      await release(outcome.message);
      return;
    }
    if (outcome.kind === 'done') {
      await settle(outcome.batchId);
      if (outcome.transientSkips > 0) {
        // The commit is not recorded, so the next sync re-diffs and picks these files up.
        await release(
          `${outcome.transientSkips} files were not ingested because the storage limit was reached. Free up space and re-sync.`
        );
        return;
      }
      const token = claimToken;
      claimToken = undefined;
      const synced = token
        ? await orgGitHubLakeConnectionRepository.recordSynced(id, token, {
            commitSha,
            defaultBranch: gitHubRepo.defaultBranch,
          })
        : null;
      if (!synced)
        logger.warn('[githubLakeIngest] claim was taken away before the sync was recorded', { connectionId: id });
      logger.info('[githubLakeIngest] synced', { connectionId: id, commitSha, batchId: outcome.batchId });
      return;
    }

    await yieldChain(outcome.batchId, {
      slice: outcome.kind === 'deadline' ? slice + 1 : slice,
      deferCount: outcome.kind === 'rate_limited' ? deferCount + 1 : deferCount,
      commitSha,
      delaySeconds: outcome.kind === 'rate_limited' ? outcome.delaySeconds : undefined,
      remaining: outcome.remaining,
    });
  } catch (err) {
    const notFound = gitHubErrorStatus(err) === 404;
    if (claimToken && connectionId) {
      const message = notFound ? GITHUB_LAKE_RECONNECT_MESSAGE : err instanceof Error ? err.message : String(err);
      await orgGitHubLakeConnectionRepository
        .releaseSyncClaim(connectionId, claimToken, message, notFound ? 'error' : 'connected')
        .catch(e => {
          logger.error(
            `[githubLakeIngest] failed to release sync claim: ${e instanceof Error ? e.message : String(e)}`
          );
          return undefined;
        });
    }
    if (notFound) return;
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping github-lake-ingest message: ${err.message}`);
      return;
    }
    throw err;
  }
});

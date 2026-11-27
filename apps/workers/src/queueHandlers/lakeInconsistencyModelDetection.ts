import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { createCompletionMeter } from '@bike4mind/server-utils/billing/meterPlatformCompletion';
import { dataLakeService, apiKeyService } from '@bike4mind/services';
import { isAiAccessRefusal } from '@bike4mind/services/userService/accountState';
import {
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeAccessGrantRepository,
  dataLakeFindingRepository,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  userRepository,
} from '@bike4mind/database';
import {
  isTerminalCreditRefusal,
  MODEL_INCONSISTENCY_RUN_LEASE_MS,
  type IDataLakeDocument,
  type IUserDocument,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { z, ZodError } from 'zod';

const LakeInconsistencyModelPayload = z.object({
  dataLakeId: z.string(),
  /** The caller who asked for the run. Carried for log correlation only; the run bills the OWNER. */
  userId: z.string(),
});

/**
 * Who this run's LLM spend is charged to: the lake's EFFECTIVE owner, which is an explicit user
 * owner-role grant where one exists and the immutable creator otherwise. Same resolver
 * `resolveLakeSpendAddressees` uses, so the party billed for a run is the party notified about lake
 * spend; a lake transferred away from its creator would otherwise keep billing them forever.
 *
 * A failed grants read throws rather than falling back to the creator: it cannot tell whether the
 * lake was transferred, so the only safe payer is none, and SQS retries the message.
 */
async function resolveSpendOwnerId(lake: IDataLakeDocument): Promise<string> {
  const grants = (await dataLakeAccessGrantRepository.listByLake(lake.id, { activeAsOf: new Date() })).map(g => ({
    principalType: g.principalType,
    principalId: g.principalId,
    role: g.role,
  }));
  return dataLakeService.resolveEffectiveOwnerIds(lake, grants)[0] ?? lake.createdByUserId;
}

/**
 * Background model-driven contradiction detection for a data lake (#3057).
 *
 * Queued rather than run inline, which is the whole point of this handler: the pass makes up to
 * `ceil(MODEL_INCONSISTENCY_MEMBER_SAMPLE / MODEL_INCONSISTENCY_BATCH_SIZE)` sequential LLM calls,
 * each able to take the SmallLLMService timeout twice over, against a Next.js server Lambda capped at
 * 60 seconds (`infra/web.ts`). Inline, a normal-sized lake exhausted the request while every call it
 * had already made was billed and nothing was persisted - the caller got a 504, no findings, and one
 * of their three hourly attempts gone. Here the work gets a 10-minute budget, a DLQ, and a retry.
 *
 * DETECTION ONLY (#2242): findings are written for a human to judge. Nothing here gates, edits or
 * removes anything.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  try {
    const payload = LakeInconsistencyModelPayload.parse(JSON.parse(event.Records[0].body));
    logger.updateMetadata({
      handler: 'lakeInconsistencyModelDetection',
      dataLakeId: payload.dataLakeId,
      userId: payload.userId,
    });

    // Re-check the flag HERE, not only at enqueue time: this message can sit in the queue for the full
    // visibility window and across retries, so without this, turning the kill-switch off would still
    // let already-queued runs spend money. Deliberately NOT `.catch(() => false)` - a rejected lookup
    // is "we could not tell", and collapsing that into a definitive off would discard real work with
    // no retry and no DLQ over a transient Mongo blip. Letting it throw fails closed for THIS attempt
    // while leaving SQS to retry. Only a definitive `false` drops the message.
    const enabled = await adminSettingsRepository.getSettingsValue('EnableLakeModelInconsistencyDetection');
    if (!enabled) {
      logger.info('[lakeInconsistencyModel] detection is off platform-wide; dropping queued run', {
        dataLakeId: payload.dataLakeId,
      });
      return;
    }

    const lake = await dataLakeRepository.findById(payload.dataLakeId);
    if (!lake) {
      logger.info('[lakeInconsistencyModel] lake no longer exists; dropping queued run', {
        dataLakeId: payload.dataLakeId,
      });
      return;
    }

    // The real mutual exclusion, guarded in the query. The route's `isLeaseHeld` precondition is a
    // fast 409 for the human clicking twice; it cannot exclude a concurrent run, because two requests
    // can both read "no lease" before either enqueues. Losing the claim means another run is already
    // reading this lake, and a second one would pay the whole LLM bill again to find the same rows.
    const claimedAt = new Date();
    const won = await dataLakeRepository.claimModelInconsistencyRun(
      lake.id,
      claimedAt,
      new Date(claimedAt.getTime() - MODEL_INCONSISTENCY_RUN_LEASE_MS)
    );
    if (!won) {
      logger.info('[lakeInconsistencyModel] another run holds the lease; dropping this one', {
        dataLakeId: payload.dataLakeId,
      });
      return;
    }

    try {
      // The EFFECTIVE owner, not the creator. `resolveEffectiveOwnerIds` prefers an explicit user
      // owner-role grant and falls back to `createdByUserId`, which is the same resolver
      // `resolveLakeSpendAddressees` uses to answer who pays for lake work - a transferred lake must
      // not bill the person it was transferred away from. A failed grant read throws before any
      // reservation; the finally below releases the lease so the SQS retry can claim it.
      const ownerUserId = await resolveSpendOwnerId(lake);
      const owner = (await userRepository.findById(ownerUserId)) as IUserDocument | null;
      if (!owner) {
        logger.warn('[lakeInconsistencyModel] lake owner not found; nobody to bill, dropping run', {
          dataLakeId: lake.id,
        });
        return;
      }

      // The LAKE OWNER's keys, not the caller's - the cost belongs to the lake's resource, matching
      // extractLakeMemoryForBatch's attribution. `endUserId` carries the same owner to the provider.
      const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
        ownerUserId,
        { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
        { logger }
      );

      const seenAt = new Date();
      const result = await dataLakeService.detectLakeInconsistenciesModel(lake, {
        db: {
          fabFiles: fabFileRepository,
          fabFileChunks: fabFileChunkRepository,
          dataLakeFindings: dataLakeFindingRepository,
        },
        apiKeyTable,
        endUserId: ownerUserId,
        meter: createCompletionMeter(owner, logger, 'data lake inconsistency detection', { systemModel: true }),
        // Persist each batch as it lands rather than once at the end, so a run killed part-way keeps
        // what it already paid for. The detector absorbs a throw here into `batchesUnpersisted`.
        onBatchFindings: findings =>
          dataLakeService
            .recordLakeFindings(
              lake.id,
              findings,
              { detector: dataLakeService.MODEL_INCONSISTENCY_DETECTOR, seenAt },
              { db: { dataLakeFindings: dataLakeFindingRepository }, logger }
            )
            .then(({ failed }) => {
              if (failed > 0) {
                logger.warn('[lakeInconsistencyModel] batch findings partially recorded', {
                  dataLakeId: lake.id,
                  failed,
                  total: findings.length,
                });
              }
            }),
        // Real Lambda clock so the between-batch budget accounts for cold start and time already
        // spent. Optional-chained like lakeMemoryExtraction's: a Context shim without the method must
        // degrade to "no deadline", not to a TypeError mid-run.
        getRemainingTimeInMillis: () => context?.getRemainingTimeInMillis?.() ?? Number.MAX_SAFE_INTEGER,
        logger,
      });

      logger.info('[lakeInconsistencyModel] run complete', {
        dataLakeId: lake.id,
        findings: result.findings.length,
        memberCount: result.memberCount,
        batchesRun: result.batchesRun,
        batchesFailed: result.batchesFailed,
        batchesUnpersisted: result.batchesUnpersisted,
        subjectsDropped: result.subjectsDropped,
        dismissedSuppressed: result.dismissedSuppressed,
        subjectsMerged: result.subjectsMerged,
        deadlineReached: result.deadlineReached,
        truncated: result.truncated,
      });
    } finally {
      // Always release, including when the run throws: the compare-and-clear inside makes this safe
      // against a stale takeover, and skipping it would leave the lake unable to re-run for the full
      // lease window over a failure SQS is about to retry anyway.
      await dataLakeRepository.releaseModelInconsistencyRun(lake.id, claimedAt).catch(err => {
        logger.warn(
          `[lakeInconsistencyModel] could not release the run lease; it expires on its own in ` +
            `${MODEL_INCONSISTENCY_RUN_LEASE_MS}ms: ${err instanceof Error ? err.message : String(err)}`,
          { dataLakeId: lake.id }
        );
      });
    }
  } catch (err) {
    // The owner cannot pay (or may not use AI): a retry is refused the same way, so consume the message.
    if (isTerminalCreditRefusal(err) || isAiAccessRefusal(err)) {
      logger.warn(`[lakeInconsistencyModel] lake owner refused; stopping run: ${(err as Error).message}`);
      return;
    }
    // Permanently-invalid message (malformed payload) - retrying cannot fix it.
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping lake model inconsistency message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err; // DB/network/LLM - let SQS retry, then DLQ.
  }
});

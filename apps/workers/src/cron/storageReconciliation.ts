/**
 * Storage Reconciliation
 *
 * Backstop for `currentStorageSize`, a running counter kept by many charge and refund sites that are
 * best-effort (a failed refund only logs). Visits every user, then every organization, in `_id` order,
 * compares the counter with the bytes of the files charged to that owner
 * (userService.reconcileUserStorage, organizationService.reconcileOrganizationStorage), records one
 * StorageDriftRecord per owner, and alerts when one owner's drift or the number of drifted owners in a
 * pass crosses a threshold.
 *
 * Dry run by default: STORAGE_RECONCILIATION_REPAIR=true also sets drifted counters to the truth, by
 * compare-and-set on the value read, so a charge or refund that lands mid-check is never overwritten
 * (the owner is left for the next pass instead). Only drift that held still since the previous pass is
 * repaired (MIN_STABLE_AGE_MS), so a newly drifted owner is repaired on the pass after it is first seen.
 *
 * One pass per PASS_INTERVAL_MS, spread over hourly invocations: each works until its time budget and
 * persists a keyset cursor and its phase (users, then organizations), so a pass survives Lambda
 * timeouts and resumes where the last one stopped.
 *
 * Schedule: hourly
 * Enabled: production + dev
 */

import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import type { IStorageDriftRecord } from '@bike4mind/common';
import {
  cacheRepository,
  connectDB,
  fabFileRepository,
  organizationRepository,
  storageDriftRecordRepository,
  userRepository,
} from '@bike4mind/database';
import { organizationService, userService } from '@bike4mind/services';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { emitMetrics } from '@server/utils/cloudwatch';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

const CLOUDWATCH_NAMESPACE = 'Lumina5/Storage';
export const STATE_KEY = 'storageReconciliation:state';
// Refreshed every invocation; only lapses if the cron stops running, and a lost cursor just restarts the pass.
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BATCH_SIZE = 200;
// Parallel per-owner aggregates within a batch; each is one indexed $group on the owner's files.
const CONCURRENCY = 10;
// Leaves a minute of the 5-minute Lambda timeout for the in-flight batch, records and alerts.
const TIME_BUDGET_MS = 4 * 60 * 1000;
const MAX_ALERT_LINES = 20;
// Unattended repair needs the same counter and truth on a check at least this old. A split adjustment
// (file row written, counter write still pending; see reconcileUserStorage) does not stay put that long.
export const MIN_STABLE_AGE_MS = 60 * 60 * 1000;
const MB = 1024 * 1024;

export interface StorageReconciliationOptions {
  repair: boolean;
  /** Alert on any single user or organization whose |drift| exceeds this many bytes. */
  driftAlertBytes: number;
  /** Alert once per pass when more than this many users and organizations have drifted by at least ceilingMinDriftBytes. */
  driftedUserCeiling: number;
  ceilingMinDriftBytes: number;
  timeBudgetMs?: number;
  now?: () => number;
}

type RepairPolicy = boolean | ((check: { counter: number; truth: number }) => boolean);

type PassPhase = 'users' | 'organizations';

interface PassState {
  /** A state stored before organizations were reconciled has no phase and resumes as the user phase. */
  phase: PassPhase;
  afterId: string | null;
  organizationAfterId: string | null;
  passStartedAt: string;
  passCompletedAt: string | null;
  checked: number;
  drifted: number;
  ceilingAlerted: boolean;
}

export interface StorageReconciliationResult {
  skipped: boolean;
  /** Users only; organizations are counted in orgsChecked and orgsDrifted. */
  checked: number;
  drifted: number;
  orgsChecked: number;
  orgsDrifted: number;
  repaired: number;
  conflicts: number;
  failed: number;
  overThreshold: IStorageDriftRecord[];
  passCompleted: boolean;
}

const parsePositive = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const optionsFromEnv = (env: NodeJS.ProcessEnv = process.env): StorageReconciliationOptions => ({
  repair: env.STORAGE_RECONCILIATION_REPAIR === 'true',
  driftAlertBytes: parsePositive(env.STORAGE_DRIFT_ALERT_BYTES, 100 * MB),
  driftedUserCeiling: parsePositive(env.STORAGE_DRIFTED_USER_CEILING, 50),
  ceilingMinDriftBytes: parsePositive(env.STORAGE_DRIFT_CEILING_MIN_BYTES, MB),
});

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

const freshPass = (now: number): PassState => ({
  phase: 'users',
  afterId: null,
  organizationAfterId: null,
  passStartedAt: new Date(now).toISOString(),
  passCompletedAt: null,
  checked: 0,
  drifted: 0,
  ceilingAlerted: false,
});

async function loadState(now: number): Promise<PassState> {
  const stored = (await cacheRepository.findByKey(STATE_KEY))?.result as Partial<PassState> | undefined;
  if (!stored) return freshPass(now);
  const state: PassState = { ...freshPass(now), ...stored };
  if (state.passCompletedAt && now - Date.parse(state.passStartedAt) >= PASS_INTERVAL_MS) return freshPass(now);
  return state;
}

async function saveState(state: PassState, now: number): Promise<void> {
  await cacheRepository.createOrUpdate({ key: STATE_KEY, result: state, expiresAt: new Date(now + STATE_TTL_MS) });
}

const ownerLabel = (record: IStorageDriftRecord) =>
  record.organizationId ? `org ${record.organizationId}` : `user ${record.userId}`;

const formatBytes = (bytes: number) => `${bytes >= 0 ? '+' : '-'}${(Math.abs(bytes) / MB).toFixed(1)} MB`;

function formatThresholdAlert(stage: string, records: IStorageDriftRecord[], options: StorageReconciliationOptions) {
  const sorted = [...records].sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
  const lines = sorted
    .slice(0, MAX_ALERT_LINES)
    .map(
      r =>
        `- ${ownerLabel(r)}: counter ${formatBytes(r.counter)}, files ${formatBytes(r.truth)}, drift ${formatBytes(r.drift)}` +
        (r.repaired ? ' (repaired)' : r.conflict ? ' (changed mid-check, left for next pass)' : '')
    );
  const more = sorted.length - lines.length;
  return [
    `:warning: *Storage counter drift* (${stage}): ${sorted.length} account(s) off by more than ` +
      `${(options.driftAlertBytes / MB).toFixed(0)} MB${options.repair ? '' : ' (dry run, counters not changed)'}.`,
    ...lines,
    ...(more > 0 ? [`...and ${more} more (see the StorageDriftRecord collection).`] : []),
  ].join('\n');
}

export async function runStorageReconciliation(
  options: StorageReconciliationOptions,
  logger: Logger = new Logger()
): Promise<StorageReconciliationResult> {
  const stage = Resource.App.stage;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + (options.timeBudgetMs ?? TIME_BUDGET_MS);
  const result: StorageReconciliationResult = {
    skipped: false,
    checked: 0,
    drifted: 0,
    orgsChecked: 0,
    orgsDrifted: 0,
    repaired: 0,
    conflicts: 0,
    failed: 0,
    overThreshold: [],
    passCompleted: false,
  };

  const state = await loadState(startedAt);
  if (state.passCompletedAt) {
    logger.log(`[StorageReconciliation] Pass from ${state.passStartedAt} already complete; waiting for the next`);
    await emitMetrics(CLOUDWATCH_NAMESPACE, [
      { name: 'StorageReconciliationRuns', value: 1, dimensions: { Stage: stage }, unit: StandardUnit.Count },
    ]);
    return { ...result, skipped: true };
  }

  const isStable = (prev: IStorageDriftRecord | undefined, check: { counter: number; truth: number }) =>
    prev !== undefined &&
    prev.counter === check.counter &&
    prev.truth === check.truth &&
    startedAt - new Date(prev.checkedAt).getTime() >= MIN_STABLE_AGE_MS;

  type OwnerKind = {
    phase: PassPhase;
    label: 'user' | 'org';
    cursor: 'afterId' | 'organizationAfterId';
    listIdsAfter: (afterId: string | null, limit: number) => Promise<string[]>;
    latestByIds: (ids: string[]) => Promise<Map<string, IStorageDriftRecord>>;
    reconcile: (ownerId: string, repair: RepairPolicy) => Promise<IStorageDriftRecord | null>;
    tally: (record: IStorageDriftRecord) => void;
  };
  const userKind: OwnerKind = {
    phase: 'users',
    label: 'user',
    cursor: 'afterId',
    listIdsAfter: (afterId, limit) => userRepository.listUserIdsAfter(afterId, limit),
    latestByIds: ids => storageDriftRecordRepository.latestByUserIds(ids),
    reconcile: async (userId, repair) => {
      const outcome = await userService.reconcileUserStorage(
        { userId, repair },
        { db: { users: userRepository, fabFiles: fabFileRepository } }
      );
      return outcome && { ...outcome, checkedAt: new Date(now()) };
    },
    tally: record => {
      result.checked++;
      if (record.drift !== 0) result.drifted++;
    },
  };
  const organizationKind: OwnerKind = {
    phase: 'organizations',
    label: 'org',
    cursor: 'organizationAfterId',
    listIdsAfter: (afterId, limit) => organizationRepository.listOrganizationIdsAfter(afterId, limit),
    latestByIds: ids => storageDriftRecordRepository.latestByOrganizationIds(ids),
    reconcile: async (organizationId, repair) => {
      const outcome = await organizationService.reconcileOrganizationStorage(
        { organizationId, repair },
        { db: { organizations: organizationRepository, fabFiles: fabFileRepository } }
      );
      return outcome && { ...outcome, checkedAt: new Date(now()) };
    },
    tally: record => {
      result.orgsChecked++;
      if (record.drift !== 0) result.orgsDrifted++;
    },
  };

  /** Walks one owner kind from its saved cursor. 'exhausted' means every owner has been visited. */
  const walkOwners = async (kind: OwnerKind): Promise<'exhausted' | 'stopped'> => {
    while (now() < deadline) {
      const page = await kind.listIdsAfter(state[kind.cursor], BATCH_SIZE);
      const previous = options.repair ? await kind.latestByIds(page) : new Map<string, IStorageDriftRecord>();
      for (let i = 0; i < page.length; i += CONCURRENCY) {
        if (now() >= deadline) return 'stopped';
        const chunk = page.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map(ownerId =>
            kind.reconcile(ownerId, options.repair && (check => isStable(previous.get(ownerId), check)))
          )
        );
        const records: IStorageDriftRecord[] = [];
        let chunkFailures = 0;
        for (const [j, outcome] of settled.entries()) {
          if (outcome.status === 'rejected') {
            chunkFailures++;
            result.failed++;
            logger.error(`[StorageReconciliation] Check failed for ${kind.label} ${chunk[j]}`, outcome.reason);
          } else if (outcome.value) {
            records.push(outcome.value);
          }
        }
        // Every check failing at once is an outage, not bad owners: keep the cursor so the next run retries.
        if (chunkFailures === chunk.length) return 'stopped';

        for (const record of records) {
          kind.tally(record);
          state.checked++;
          if (Math.abs(record.drift) >= options.ceilingMinDriftBytes) state.drifted++;
          if (record.repaired) result.repaired++;
          if (record.conflict) result.conflicts++;
          if (Math.abs(record.drift) > options.driftAlertBytes) result.overThreshold.push(record);
        }
        // The checks (and any CAS repairs) already ran, so a rejected append must not throw before the
        // cursor save: the chunk would be retried on every run and the pass would never advance.
        try {
          await storageDriftRecordRepository.appendMany(records);
        } catch (error) {
          logger.error(
            `[StorageReconciliation] Failed to record ${records.length} ${kind.label} drift record(s); continuing`,
            error
          );
        }
        state[kind.cursor] = chunk[chunk.length - 1];
        await saveState(state, now());
      }

      if (page.length < BATCH_SIZE) return 'exhausted';
    }
    return 'stopped';
  };

  try {
    if (state.phase === 'users' && (await walkOwners(userKind)) === 'exhausted') {
      state.phase = 'organizations';
      await saveState(state, now());
    }
    if (state.phase === 'organizations' && (await walkOwners(organizationKind)) === 'exhausted') {
      state.passCompletedAt = new Date(now()).toISOString();
      result.passCompleted = true;
      await saveState(state, now());
    }
  } finally {
    // Flush the threshold alert here, not after the loop: a later page can throw once the cursor has
    // already advanced past these users, and overThreshold only lives in memory, so the retry would
    // resume after them and never tell anyone.
    for (const record of result.overThreshold) {
      logger.warn('[StorageReconciliation] Storage drift over threshold', record);
    }
    if (result.overThreshold.length > 0) {
      await postMessageToSlack(formatThresholdAlert(stage, result.overThreshold, options));
    }
  }
  if (!state.ceilingAlerted && state.drifted > options.driftedUserCeiling) {
    // Mark the ceiling alert sent only on a successful post: a Slack outage must not silence the one
    // signal that a charge path is losing adjustments for the rest of the pass.
    const posted = await postMessageToSlack(
      `:warning: *Storage counter drift is widespread* (${stage}): ${state.drifted} of ${state.checked} accounts ` +
        `checked so far in the pass started ${state.passStartedAt} have a counter off by at least ` +
        `${(options.ceilingMinDriftBytes / MB).toFixed(1)} MB from their files ` +
        `(ceiling ${options.driftedUserCeiling}). A charge or refund path is likely losing adjustments.`
    );
    if (posted) {
      state.ceilingAlerted = true;
      await saveState(state, now());
    }
  }

  const dimensions = { Stage: stage };
  await emitMetrics(CLOUDWATCH_NAMESPACE, [
    { name: 'StorageReconciliationRuns', value: 1, dimensions, unit: StandardUnit.Count },
    { name: 'StorageUsersChecked', value: result.checked, dimensions, unit: StandardUnit.Count },
    { name: 'StorageUsersDrifted', value: result.drifted, dimensions, unit: StandardUnit.Count },
    { name: 'StorageOrgsChecked', value: result.orgsChecked, dimensions, unit: StandardUnit.Count },
    { name: 'StorageOrgsDrifted', value: result.orgsDrifted, dimensions, unit: StandardUnit.Count },
    { name: 'StorageDriftOverThreshold', value: result.overThreshold.length, dimensions, unit: StandardUnit.Count },
    { name: 'StorageCountersRepaired', value: result.repaired, dimensions, unit: StandardUnit.Count },
    { name: 'StorageRepairConflicts', value: result.conflicts, dimensions, unit: StandardUnit.Count },
    { name: 'StorageReconciliationFailures', value: result.failed, dimensions, unit: StandardUnit.Count },
  ]);

  logger.log(
    `[StorageReconciliation] Checked ${result.checked} user(s) (${result.drifted} drifted) and ` +
      `${result.orgsChecked} org(s) (${result.orgsDrifted} drifted): ` +
      `${result.overThreshold.length} over threshold, ${result.repaired} repaired, ${result.conflicts} conflicts, ` +
      `${result.failed} failed${result.passCompleted ? '; pass complete' : ''}${options.repair ? '' : ' (dry run)'}`
  );
  return result;
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  const { overThreshold, ...summary } = await runStorageReconciliation(optionsFromEnv(), logger);
  return { statusCode: 200, body: JSON.stringify({ ...summary, overThreshold: overThreshold.length }) };
}

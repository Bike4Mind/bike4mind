import type {
  IDataLakeResearchConfigRepository,
  IDataLakeResearchRunDocument,
  IDataLakeResearchRunRepository,
  ResearchScheduleSkipReason,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { researchRunChange } from '../dataLakeService/diffLakeConfig';
import type { LakeGrant, ManageActor } from '../dataLakeService/manageRule';
import {
  recordLakeConfigChange,
  type LakeConfigAuditAdapters,
  type LakeConfigAuditLakeRef,
} from '../dataLakeService/recordLakeConfigChange';
import { normalizeResearchLevers } from './researchLevers';

/**
 * Turn a saved configuration into a queued run (#1682). The API calls this, then sends the message;
 * the row exists first so a user who clicked Run sees a run immediately rather than after a worker
 * picks the message up.
 *
 * The research scheduler (`runDueResearchSchedules`) calls exactly this too, with a `periodic`
 * starter. That is the whole reason the configuration is a saved object.
 */

/** Who started the run: a person pressing Run, or the scheduler with nobody behind it. */
export type ResearchRunStarter =
  { trigger: 'on_demand'; actor: ManageActor; grants: readonly LakeGrant[] } | { trigger: 'periodic' };

type ResearchRunRefusalReason = Exclude<ResearchScheduleSkipReason, 'review_backlog' | 'lake_inactive'>;

/**
 * A spend rail refused the start. Tagged so the scheduler can record WHICH rail as a skip reason
 * and retry soon, instead of treating a busy lake as a failed schedule. Still a 400 to the route.
 *
 * A tagged BadRequestError rather than a subclass on purpose: `class ... extends BadRequestError`
 * evaluates the utils export when this module loads, which breaks every suite that imports the
 * services barrel under a partial `@bike4mind/utils` mock.
 */
export type ResearchRunRefusedError = BadRequestError & { reason: ResearchRunRefusalReason };

const REFUSAL_REASONS: ReadonlySet<unknown> = new Set<ResearchRunRefusalReason>(['run_in_progress', 'daily_cap']);

const researchRunRefused = (message: string, reason: ResearchRunRefusalReason): ResearchRunRefusedError =>
  Object.assign(new BadRequestError(message), { reason });

export function isResearchRunRefusal(error: unknown): error is ResearchRunRefusedError {
  return error instanceof BadRequestError && 'reason' in error && REFUSAL_REASONS.has(error.reason);
}

export interface StartResearchRunAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    dataLakeResearchConfigs: Pick<IDataLakeResearchConfigRepository, 'findByIdInLake' | 'recordRunStarted'>;
    dataLakeResearchRuns: Pick<IDataLakeResearchRunRepository, 'createRun' | 'countActiveByLake' | 'countStartedSince'>;
    // REQUIRED - see the matching note on ResearchConfigAdapters.
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
  };
  now?: () => Date;
}

/**
 * How many runs one lake may start per day. A spend rail rather than an abuse control - the manage
 * gate already decides who may start one at all - so it is generous, and it is per LAKE rather than
 * per user because the money a run spends is charged against the lake's owner, not its starter.
 */
export const RESEARCH_RUNS_PER_LAKE_PER_DAY = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

export async function startResearchRun(
  configId: string,
  lake: LakeConfigAuditLakeRef,
  starter: ResearchRunStarter,
  { db, logger, now = () => new Date() }: StartResearchRunAdapters
): Promise<IDataLakeResearchRunDocument> {
  const dataLakeId = lake.id;
  const config = await db.dataLakeResearchConfigs.findByIdInLake(configId, dataLakeId);
  if (!config) throw new NotFoundError('Research configuration not found');

  // One at a time per lake. Checked before the daily cap because it is the guard whose message is
  // the clearer of the two.
  //
  // Read-then-write, and knowingly so: there is no partial-unique index behind it and no
  // compare-and-set, so two POSTs racing (two tabs, a client retry, a proxy replay) can both read
  // zero and both insert. The daily cap and the 20-config cap are racy the same way. What bounds
  // the damage is that each run carries its own cost ceiling, so a lost race costs one extra
  // ceiling rather than an unbounded amount - this is a spend rail, not a mutual exclusion
  // primitive, and `claimForExecution` is where correctness actually lives.
  const active = await db.dataLakeResearchRuns.countActiveByLake(dataLakeId);
  if (active > 0) {
    throw researchRunRefused('A research run is already in progress for this data lake', 'run_in_progress');
  }

  const startedAt = now();
  const started = await db.dataLakeResearchRuns.countStartedSince(dataLakeId, new Date(startedAt.getTime() - DAY_MS));
  if (started >= RESEARCH_RUNS_PER_LAKE_PER_DAY) {
    // "in the last 24 hours", not "today": the window is rolling (see DAY_MS), so a manager
    // refused at 10am because of a 3pm burst yesterday can act on the former and not the latter.
    throw researchRunRefused(
      `This data lake has already started ${RESEARCH_RUNS_PER_LAKE_PER_DAY} research runs in the last 24 hours`,
      'daily_cap'
    );
  }

  const run = await db.dataLakeResearchRuns.createRun({
    dataLakeId,
    configId,
    // Re-normalized at START, not copied raw: this snapshot is what the loop executes and what the
    // run reports it ran with, so it has to be the post-clamp values or the two would disagree for
    // any config stored before a bound tightened.
    levers: normalizeResearchLevers(config),
    // How THIS run started, not the config's trigger: Run now on a scheduled config is still on-demand.
    trigger: starter.trigger,
    startedByUserId: starter.trigger === 'on_demand' ? starter.actor.userId : null,
    startedAt: null,
    completedAt: null,
  });

  // After the run row exists, so a failure here costs a stale "last run" timestamp rather than a
  // run the user started and cannot see. Best-effort inside the repository for the same reason.
  await db.dataLakeResearchConfigs.recordRunStarted(configId, startedAt);

  // `grants` comes from the caller's own gate (assertLakeResearchManage), not re-fetched here -
  // the gate and the recorded manage rung must agree on the same grant set, the same reasoning
  // reviewDataLakeProposal's resolveReviewable applies to its own reused grants. A periodic start has
  // no caller and no gate behind it, so it records under the `system` rung instead, the same as
  // `recordResearchRunOutcome`'s own periodic-safe path.
  await recordLakeConfigChange(
    {
      ...(starter.trigger === 'on_demand'
        ? { actor: starter.actor, grants: starter.grants }
        : { actor: { userId: '', isAdmin: false, administeredOrgIds: [] }, manageRung: 'system' as const }),
      lake,
      action: 'start-research-run',
      // The QUERY, not the config's name: `recordResearchRunOutcome` (the matching outcome event,
      // recorded later from the background executor) only has the run's own levers snapshot to work
      // from, never the config document - using the same identifier here is what lets a reader match
      // a `start-research-run` row to the `complete-research-run` row it belongs to. Read from
      // `run.levers` (the normalized snapshot just created above), not `config.query` directly, so
      // the two rows are guaranteed to agree even for a config saved before a normalization change.
      // `run.id` disambiguates two runs of the same config with an unedited (so identical) query.
      changes: [researchRunChange(run.levers.query, 'started', run.id)],
    },
    { db, logger }
  );

  return run;
}

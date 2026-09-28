import type {
  IDataLakeResearchConfigRepository,
  IDataLakeResearchRunDocument,
  IDataLakeResearchRunRepository,
  ResearchScheduleSkipReason,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
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
export type ResearchRunStarter = { trigger: 'on_demand'; actorUserId: string } | { trigger: 'periodic' };

/**
 * A spend rail refused the start. Typed so the scheduler can record WHICH rail as a skip reason
 * and retry soon, instead of treating a busy lake as a failed schedule. Still a 400 to the route.
 */
export class ResearchRunRefusedError extends BadRequestError {
  constructor(
    message: string,
    readonly reason: Exclude<ResearchScheduleSkipReason, 'review_backlog'>
  ) {
    super(message);
  }
}

export interface StartResearchRunAdapters {
  db: {
    dataLakeResearchConfigs: Pick<IDataLakeResearchConfigRepository, 'findByIdInLake' | 'recordRunStarted'>;
    dataLakeResearchRuns: Pick<IDataLakeResearchRunRepository, 'createRun' | 'countActiveByLake' | 'countStartedSince'>;
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
  dataLakeId: string,
  starter: ResearchRunStarter,
  { db, now = () => new Date() }: StartResearchRunAdapters
): Promise<IDataLakeResearchRunDocument> {
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
    throw new ResearchRunRefusedError('A research run is already in progress for this data lake', 'run_in_progress');
  }

  const startedAt = now();
  const started = await db.dataLakeResearchRuns.countStartedSince(dataLakeId, new Date(startedAt.getTime() - DAY_MS));
  if (started >= RESEARCH_RUNS_PER_LAKE_PER_DAY) {
    // "in the last 24 hours", not "today": the window is rolling (see DAY_MS), so a manager
    // refused at 10am because of a 3pm burst yesterday can act on the former and not the latter.
    throw new ResearchRunRefusedError(
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
    startedByUserId: starter.trigger === 'on_demand' ? starter.actorUserId : null,
    startedAt: null,
    completedAt: null,
  });

  // After the run row exists, so a failure here costs a stale "last run" timestamp rather than a
  // run the user started and cannot see. Best-effort inside the repository for the same reason.
  await db.dataLakeResearchConfigs.recordRunStarted(configId, startedAt);

  return run;
}

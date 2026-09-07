import type {
  IDataLakeResearchConfigRepository,
  IDataLakeResearchRunDocument,
  IDataLakeResearchRunRepository,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { normalizeResearchLevers } from './researchLevers';

/**
 * Turn a saved configuration into a queued run (#1682). The API calls this, then sends the message;
 * the row exists first so a user who clicked Run sees a run immediately rather than after a worker
 * picks the message up.
 *
 * v2 calls exactly this, from a scheduler instead of a route. That is the whole reason the
 * configuration is a saved object.
 */

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
  actorUserId: string,
  { db, now = () => new Date() }: StartResearchRunAdapters
): Promise<IDataLakeResearchRunDocument> {
  const config = await db.dataLakeResearchConfigs.findByIdInLake(configId, dataLakeId);
  if (!config) throw new NotFoundError('Research configuration not found');

  // One at a time per lake. Checked before the daily cap because it is the guard that catches the
  // common mistake (a double-clicked Run button), and it deserves the clearer message of the two.
  const active = await db.dataLakeResearchRuns.countActiveByLake(dataLakeId);
  if (active > 0) {
    throw new BadRequestError('A research run is already in progress for this data lake');
  }

  const startedAt = now();
  const started = await db.dataLakeResearchRuns.countStartedSince(dataLakeId, new Date(startedAt.getTime() - DAY_MS));
  if (started >= RESEARCH_RUNS_PER_LAKE_PER_DAY) {
    throw new BadRequestError(
      `This data lake has already started ${RESEARCH_RUNS_PER_LAKE_PER_DAY} research runs today`
    );
  }

  const run = await db.dataLakeResearchRuns.createRun({
    dataLakeId,
    configId,
    // Re-normalized at START, not copied raw: this snapshot is what the loop executes and what the
    // run reports it ran with, so it has to be the post-clamp values or the two would disagree for
    // any config stored before a bound tightened.
    levers: normalizeResearchLevers(config),
    trigger: config.trigger,
    startedByUserId: actorUserId,
    startedAt: null,
    completedAt: null,
  });

  // After the run row exists, so a failure here costs a stale "last run" timestamp rather than a
  // run the user started and cannot see. Best-effort inside the repository for the same reason.
  await db.dataLakeResearchConfigs.recordRunStarted(configId, startedAt);

  return run;
}

import type { IDataLakeDocument, IDataLakeResearchRunDocument } from '@bike4mind/common';
import { dataLakeResearchRunRepository } from '@bike4mind/database';
import { dataLakeResearchService } from '@bike4mind/services';
import { sendToQueue } from '@server/utils/sqs';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';

/**
 * Hand a freshly started run to the research worker. Shared by Run now
 * (`pages/api/data-lakes/[id]/research/runs`) and the research scheduler
 * (`cron/dataLakeResearchSchedule.ts`).
 *
 * On a failed send the row is settled `failed` before rethrowing: nothing will ever pick it up, and a
 * permanently-queued run holds the one-at-a-time guard closed against every later attempt. Uses
 * `settleQueuedRun`, not `settleRun`: the send can reject after the message actually landed (an ack
 * lost to a timeout), and if the executor already claimed the run in that window it owns the row
 * (`running`), not this call. `settleQueuedRun` matches ONLY `queued`, so that race is a no-op here
 * instead of clobbering the executor's outcome. When it does settle, the failure also needs its own
 * `complete-research-run` History row - `runLakeResearch.ts` never gets a message to record one.
 */
export async function queueResearchRun(
  run: IDataLakeResearchRunDocument,
  lake: Pick<IDataLakeDocument, 'id' | 'createdByUserId' | 'organizationId'>,
  queueUrl: string,
  logger: { warn: (message: string) => void }
): Promise<void> {
  try {
    await sendToQueue(queueUrl, { runId: run.id, dataLakeId: run.dataLakeId });
  } catch (error) {
    let alreadySettledElsewhere = false;
    await dataLakeResearchRunRepository
      .settleQueuedRun(run.id, {
        status: 'failed',
        completedAt: new Date(),
        spentMicroUsd: 0,
        totals: run.totals,
        error: 'The run could not be queued for execution. Try again shortly.',
      })
      .then(settled => {
        alreadySettledElsewhere = !settled;
      })
      .catch(err => logger.warn(`[queueResearchRun] settle failed: ${err}`));
    if (!alreadySettledElsewhere) {
      await dataLakeResearchService
        .recordResearchRunOutcome(lake, run.levers.query, 'failed', run.id, {
          db: { ...lakeConfigAuditDb },
          logger,
        })
        .catch(err => logger.warn(`[queueResearchRun] outcome record failed: ${err}`));
    }
    throw error;
  }
}

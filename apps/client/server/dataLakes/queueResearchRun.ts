import type { IDataLakeResearchRunDocument } from '@bike4mind/common';
import { dataLakeResearchRunRepository } from '@bike4mind/database';
import { sendToQueue } from '@server/utils/sqs';

/**
 * Hand a freshly started run to the research worker. Shared by Run now
 * (`pages/api/data-lakes/[id]/research/runs`) and the research scheduler
 * (`cron/dataLakeResearchSchedule.ts`).
 *
 * On a failed send the row is settled `failed` before rethrowing: nothing will ever pick it up, and a
 * permanently-queued run holds the one-at-a-time guard closed against every later attempt.
 */
export async function queueResearchRun(run: IDataLakeResearchRunDocument, queueUrl: string): Promise<void> {
  try {
    await sendToQueue(queueUrl, { runId: run.id, dataLakeId: run.dataLakeId });
  } catch (error) {
    await dataLakeResearchRunRepository.settleRun(run.id, {
      status: 'failed',
      completedAt: new Date(),
      spentMicroUsd: 0,
      totals: run.totals,
      error: 'The run could not be queued for execution. Try again shortly.',
    });
    throw error;
  }
}

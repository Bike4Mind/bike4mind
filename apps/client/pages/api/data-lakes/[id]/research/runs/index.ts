import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeResearchService } from '@bike4mind/services';
import { dataLakeResearchConfigRepository, dataLakeResearchRunRepository } from '@bike4mind/database';
import { InternalServerError } from '@bike4mind/utils';
import { Request } from 'express';
import { Resource } from 'sst';
import { z } from 'zod';
import { assertLakeResearchManage } from '@server/dataLakes/assertLakeResearchManage';
import { sendToQueue } from '@server/utils/sqs';

const StartInput = z.object({ configId: z.string() });

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

/** Bounds one page of run history when a caller does not ask for a size. */
const DEFAULT_LIMIT = 20;

/**
 * GET  /api/data-lakes/:id/research/runs - the lake's run history (#1682).
 * POST /api/data-lakes/:id/research/runs - start a run from a saved configuration.
 *
 * The POST writes the run row FIRST and enqueues second, so a user who clicked Run sees a queued
 * run immediately instead of waiting on a worker. The row is also what makes the enqueue safe to
 * retry: the handler claims it with a compare-and-set, so a duplicate message runs nothing.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const { limit } = ListQuery.parse(req.query);
    const lake = await assertLakeResearchManage(req, id);

    const runs = await dataLakeResearchRunRepository.listByLake(lake.id, { limit: limit ?? DEFAULT_LIMIT });
    return res.json({ data: runs });
  })
  .post(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    // Gated before the body is parsed, matching the config routes: a caller who may not manage this
    // lake should not be able to probe the request schema by reading which field it complains about.
    const lake = await assertLakeResearchManage(req, id);
    const { configId } = StartInput.parse(req.body);

    // Checked BEFORE the row is written. Without the queue there is no executor, so a run started
    // here would sit `queued` forever and then block every later run behind the one-at-a-time
    // guard - a self-host install that never wired the queue would look permanently busy.
    const queueUrl = Resource.dataLakeResearchQueue?.url;
    if (!queueUrl) {
      throw new InternalServerError('Research runs are not available on this deployment');
    }

    const run = await dataLakeResearchService.startResearchRun(configId, lake.id, req.user!.id, {
      db: {
        dataLakeResearchConfigs: dataLakeResearchConfigRepository,
        dataLakeResearchRuns: dataLakeResearchRunRepository,
      },
    });

    try {
      await sendToQueue(queueUrl, { runId: run.id, dataLakeId: lake.id });
    } catch (error) {
      // Settle the row rather than leaving it `queued`: nothing will ever pick it up, and a
      // permanently-queued run holds the one-at-a-time guard closed against every later attempt.
      await dataLakeResearchRunRepository.settleRun(run.id, {
        status: 'failed',
        completedAt: new Date(),
        spentMicroUsd: 0,
        totals: run.totals,
        error: 'The run could not be queued for execution. Try again shortly.',
      });
      throw error;
    }

    return res.status(202).json({ data: run });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

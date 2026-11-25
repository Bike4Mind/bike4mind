import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@bike4mind/server-utils/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { researchRunEnvelopeResponseSchema, researchRunListResponseSchema } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { listLakeResearchRuns, startLakeResearchRun } from '@server/dataLakes/research/researchRunHandlers';
import { respond } from '@server/utils/respond';

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
 * retry: the handler claims it with a compare-and-set, so a duplicate message runs nothing. The
 * handler bodies are shared with the public v1 routes (`server/dataLakes/research`).
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const runs = await listLakeResearchRuns(req, id, await toAccessContext(req), () => ({
      limit: ListQuery.parse(req.query).limit ?? DEFAULT_LIMIT,
    }));
    return respond(res, researchRunListResponseSchema, { data: runs });
  })
  .post(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { id } = req.query as { id: string };
    // Computed outside the transaction: it issues concurrent reads, which an ambient session rejects.
    const ctx = await toAccessContext(req);

    const run = await startLakeResearchRun(req, id, ctx, () => StartInput.parse(req.body));
    return respond(res, researchRunEnvelopeResponseSchema, { data: run }, 202);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

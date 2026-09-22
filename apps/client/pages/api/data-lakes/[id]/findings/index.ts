import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, dataLakeFindingRepository } from '@bike4mind/database';
import { INCONSISTENCY_KINDS, LAKE_FINDING_DETECTORS, LAKE_FINDING_STATUSES } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

const ListQuery = z.object({
  status: z.enum(LAKE_FINDING_STATUSES).optional(),
  kind: z.enum(INCONSISTENCY_KINDS).optional(),
  detector: z.enum(LAKE_FINDING_DETECTORS).optional(),
  // The union is load-bearing, not decoration. A repeated query param arrives as a string[], and
  // `z.coerce.number()` alone does NOT refuse one: `Number(['10'])` is 10, so the single-element
  // form would coerce silently while only the multi-element form landed NaN. Narrowing the input
  // to a scalar first makes both array shapes a 400, so the page bound is always a thing the
  // schema decided rather than something Array.prototype.toString happened to produce. `Number`
  // then does the coercion explicitly, because `z.coerce.number()` accepts `unknown` - the very
  // reason it swallows the array, and why it will not sit on the right of this pipe. A
  // non-numeric string lands NaN, which `z.number()` rejects.
  limit: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().int().min(1).max(200)).optional(),
  // Same scalar-first coercion as `limit`, and for the same reason: a repeated `offset` must be a
  // 400, not silently coerced or NaN'd.
  offset: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().int().min(0)).optional(),
});

/** Bounds one page of the queue when a caller does not ask for a size. */
const DEFAULT_LIMIT = 50;

/**
 * GET /api/data-lakes/:id/findings - one lake's detected corpus problems (#3039), most recently
 * seen first, narrowed by any combination of status, kind and detector.
 *
 * MANAGE-gated via `assertLakeWriteAccess`, exactly like the sibling `inconsistencies.ts` and for
 * the same reason: a finding carries EXCERPTS of the lake's documents, and it is the PROSE that
 * decides the gate here, not the mutation - a reader who can see a lake is not necessarily entitled
 * to read every member's text, which is why `redactLakeForActor` withholds the stored report from
 * readers too. The read-gated view of this data stays the counts-only summary on GET /health.
 *
 * Using that gate also means fallback (static registry) lakes are refused, which is correct rather
 * than incidental: detection never runs against one, so it has no findings to list.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const { status, kind, detector, limit, offset } = ListQuery.parse(req.query);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const pageLimit = limit ?? DEFAULT_LIMIT;
    // Fetched one row past the page so `hasMore` reflects the queue, not a guess from `data.length
    // === pageLimit` - a queue that ends exactly on a page boundary would otherwise read as having
    // more.
    const findings = await dataLakeFindingRepository.listByLake(lake.id, {
      status,
      kind,
      detector,
      limit: pageLimit + 1,
      offset: offset ?? 0,
    });

    return res.json({ data: findings.slice(0, pageLimit), hasMore: findings.length > pageLimit });
  });

export const config = { api: { externalResolver: true } };

export default handler;

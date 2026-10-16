import { forcedRetrievalFloorAboveMeasured, forcedRetrievalFloorAboveMeasuredMessage } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

import { BadRequestError } from '@server/utils/errors';
import { resolveDefaultEmbeddingModel } from '@server/utils/resolveDefaultEmbeddingModel';

/**
 * Refuses a `forcedRetrievalMinSimilarityPct` above the floor measured for the default embedding
 * model, unless the caller sent `confirmAboveMeasuredFloor: true`. Used by both the platform write
 * (`/api/settings/update`) and the scoped-override write (`/api/admin/scoped-settings`).
 */
export async function refuseFloorAboveMeasured(pct: number, logger: Logger): Promise<void> {
  const model = await resolveDefaultEmbeddingModel(logger, 'forced-retrieval-floor-write');
  const measured = forcedRetrievalFloorAboveMeasured(pct, model);
  if (measured === undefined) return;
  throw new BadRequestError(
    `${forcedRetrievalFloorAboveMeasuredMessage(pct, measured, model)} ` +
      'To save it anyway, resend with confirmAboveMeasuredFloor: true.'
  );
}

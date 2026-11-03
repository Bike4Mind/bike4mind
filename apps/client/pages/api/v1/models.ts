/**
 * GET /api/v1/models - the public, cursor-paginated projection of the caller's model list.
 *
 * Auth mode, the `ai:chat` / `ai:generate` scopes and query validation come from
 * `listModelsContract`. The list itself is the one GET /api/models serves (getCallerModelList),
 * mapped through `toPublicModel` so internal catalog fields never reach the wire. The reasoning
 * fields are computed here because `@bike4mind/common` cannot import llm-adapters.
 */

import { listModelsContract, toPublicModel, type ModelInfo } from '@bike4mind/common';
import { reasoningEffortsFor, reasonsWithinOutputBudget } from '@bike4mind/llm-adapters';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { paginateById } from '@server/utils/cursorPagination';
import { getCallerModelList } from '@server/utils/callerModelList';

const CURSOR_SCOPE = 'v1.models';

const toPublicModelWithReasoning = (model: ModelInfo) =>
  toPublicModel(model, {
    reasonsWithinOutputBudget: reasonsWithinOutputBudget(model),
    reasoningEfforts: reasoningEffortsFor(model),
  });

const handler = nextRouteForContract(listModelsContract, {
  // Integrators re-list before choosing a model; that lookup should not burn the daily
  // budget the generation itself needs - same exemption as GET /api/v1/credits.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  const { models } = await getCallerModelList(req.user, req.logger);
  // Filtered here, not in getCallerModelList: the picker shares that list and keeps a disabled model
  // when it is the caller's active selection. Speech-to-text models (aws transcribe) are not servable
  // by completions or image generation.
  const callable = models.filter(model => !model.disabled && model.type !== 'speech-to-text');
  const page = paginateById(callable, { limit, cursor, scope: CURSOR_SCOPE });

  // Built from the caller's own provider keys - never cacheable by a shared cache.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ data: page.items.map(toPublicModelWithReasoning), next_cursor: page.nextCursor });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};

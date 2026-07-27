import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { modelCatalogRepository, modelDiscoveryStateRepository } from '@bike4mind/database';
import { FALLBACK_PREFERENCES, DEFAULT_FALLBACK_CHAIN } from '@bike4mind/utils';
import {
  catalogLifecycles,
  checkStaleModelReferences,
  classifyModelReference,
  getAvailableModels,
  getExpiredCatalogModels,
  getExpiringModels,
} from '@bike4mind/llm-adapters';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';

/**
 * Deprecation queue and lifecycle report (spec sec 5.10 / 7).
 *
 * GET  -> the horizon (expiring), the catalog's EXPIRED view, the operator
 *         queue of unresolved discovery suggestions, and the stale-reference
 *         report over the hardcoded model-id surfaces.
 * POST -> settle one queue item: 'dismiss' records the verdict, 'accept'
 *         appends an operator lifecycle row and then records it.
 *
 * The expired view reads catalog lifecycle rather than getAvailableModels,
 * whose deprecation filter is precisely what hides these models - which is why
 * the old version of this endpoint could never show one.
 */

/** Lifecycle statuses a row may carry; a suggestion outside them cannot be appended. */
const LIFECYCLE_STATUSES = ['discovered', 'active', 'legacy', 'deprecated', 'retired', 'unlisted'] as const;

const ResolveBody = z.object({
  modelId: z.string().min(1),
  action: z.enum(['accept', 'dismiss']),
  note: z.string().optional(),
  /** Overrides the suggested successor; validated like any other reference below. */
  replacedBy: z.string().min(1).optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    const daysAhead = parseInt(req.query.daysAhead as string) || 90;

    const [liveModels, rows, pending] = await Promise.all([
      // Private included: this is an operator view, not the picker.
      getAvailableModels(null, { includePrivate: true }),
      modelCatalogRepository.rowsInForce(),
      modelDiscoveryStateRepository.pendingSuggestions(),
    ]);

    const lifecycles = catalogLifecycles(rows);

    res.json({
      daysAhead,
      totalModels: liveModels.length,
      expiringOrExpired: getExpiringModels(liveModels, daysAhead),
      expired: getExpiredCatalogModels(lifecycles),
      queue: pending.map(state => ({ modelId: state.modelId, suggestion: state.suggestion })),
      // The two arguments together are the unfiltered view: a model the picker
      // filter dropped is gone from liveModels but still carries a lifecycle
      // here, so it classifies as deprecated instead of vanishing into 'unknown'.
      staleReferences: checkStaleModelReferences({
        models: liveModels,
        lifecycles,
        fallbackChains: FALLBACK_PREFERENCES,
        defaultChain: DEFAULT_FALLBACK_CHAIN,
      }),
    });
  })
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'invalid request');
    const { modelId, action } = parsed.data;

    const state = await modelDiscoveryStateRepository.findByModelId(modelId);
    const suggestion = state?.suggestion;
    if (!suggestion) throw new BadRequestError(`${modelId} has no lifecycle suggestion to settle`);
    if (suggestion.resolution) {
      throw new BadRequestError(`${modelId}'s suggestion was already ${suggestion.resolution}`);
    }

    if (action === 'dismiss') {
      return res.json({ state: await modelDiscoveryStateRepository.resolveSuggestion(modelId, 'dismissed') });
    }

    const note = parsed.data.note?.trim() ?? '';
    if (!note) throw new BadRequestError('note is required: it is the audit trail for this lifecycle change');

    const status = suggestion.status ?? 'deprecated';
    if (!(LIFECYCLE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestError(`suggested status '${status}' is not a lifecycle status this build can write`);
    }

    const replacedBy = parsed.data.replacedBy ?? suggestion.replacedBy;
    if (replacedBy) {
      // A successor must not itself be a stale reference - the same clauses the
      // run's auto-remap has to pass (sec 8). Checked through the report's own
      // predicate so the queue cannot accept what the report would then flag.
      const [live, rows] = await Promise.all([
        getAvailableModels(null, { includePrivate: true }),
        modelCatalogRepository.rowsInForce(),
      ]);
      const problem = classifyModelReference(replacedBy, { models: live, lifecycles: catalogLifecycles(rows) });
      if (problem === 'unknown') {
        throw new BadRequestError(`replacedBy ${replacedBy} is unknown to the merged model list`);
      }
      if (problem) {
        throw new BadRequestError(`replacedBy ${replacedBy} is ${problem} and cannot replace ${modelId}`);
      }
    }

    const row = await modelCatalogRepository.append({
      modelId,
      source: 'operator',
      patch: {
        lifecycle: {
          status: status as (typeof LIFECYCLE_STATUSES)[number],
          ...(suggestion.deprecationDate ? { deprecationDate: suggestion.deprecationDate } : {}),
          ...(suggestion.retirementDate ? { retirementDate: suggestion.retirementDate } : {}),
          ...(replacedBy ? { replacedBy } : {}),
        },
      },
      ownedGroups: ['lifecycle'],
      effectiveFrom: new Date(),
      // The admin id is the contributor: this row is their decision, taken on a
      // suggestion whose own source is recorded on the discovery state.
      contributors: [{ group: 'lifecycle', source: req.user.id }],
      note,
    });

    return res.json({ row, state: await modelDiscoveryStateRepository.resolveSuggestion(modelId, 'accepted') });
  });

export default handler;

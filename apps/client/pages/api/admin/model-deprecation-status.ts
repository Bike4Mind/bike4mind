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

/** The catalog's date format. A docs parser can produce anything, and the append throws on it. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

    const [live, rows] = await Promise.all([
      getAvailableModels(null, { includePrivate: true }),
      modelCatalogRepository.rowsInForce(),
    ]);
    const lifecycles = catalogLifecycles(rows);
    // This row owns the whole lifecycle group and the merge swaps the object
    // wholesale, so every field the suggestion is silent about has to be
    // restated: accepting a remap-only suggestion must not drop the dates that
    // hide the model. The view is operator-inclusive, i.e. what is in force now.
    const current = lifecycles.get(modelId);

    const status = suggestion.status ?? current?.status ?? 'deprecated';
    if (!(LIFECYCLE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestError(`suggested status '${status}' is not a lifecycle status this build can write`);
    }

    const deprecationDate = suggestion.deprecationDate ?? current?.deprecationDate;
    const retirementDate = suggestion.retirementDate ?? current?.retirementDate;
    for (const [field, value] of [
      ['deprecationDate', deprecationDate],
      ['retirementDate', retirementDate],
    ] as const) {
      if (value !== undefined && !CALENDAR_DATE.test(value)) {
        throw new BadRequestError(`${field} '${value}' is not a YYYY-MM-DD calendar date`);
      }
    }

    const replacedBy = parsed.data.replacedBy ?? suggestion.replacedBy ?? current?.replacedBy;
    if (replacedBy) {
      // An operator override is sovereign: the only clauses it has to pass are
      // that the successor exists and is not itself sunset. Checked through the
      // report's own predicate so the queue cannot accept what it would flag.
      const problem = classifyModelReference(replacedBy, { models: live, lifecycles });
      if (problem === 'unknown') {
        throw new BadRequestError(`replacedBy ${replacedBy} is unknown to the merged model list`);
      }
      // 'not-invocable' (the catalog knows the id but no configured key lists
      // it) passes the gate: an operator may accept a successor before its key
      // exists. The GET report still surfaces it as a stale reference.
      if (problem && problem !== 'not-invocable') {
        throw new BadRequestError(`replacedBy ${replacedBy} is ${problem} and cannot replace ${modelId}`);
      }
    }

    const row = await modelCatalogRepository.append({
      modelId,
      source: 'operator',
      patch: {
        lifecycle: {
          status: status as (typeof LIFECYCLE_STATUSES)[number],
          ...(deprecationDate ? { deprecationDate } : {}),
          ...(retirementDate ? { retirementDate } : {}),
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

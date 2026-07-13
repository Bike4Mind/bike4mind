import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { generateModelPriceSeed, modelPriceRepository, SEED_NOTE } from '@bike4mind/database';
import { MODEL_PRICE_UNITS, ModelPriceTier } from '@bike4mind/common';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';

/**
 * Admin surface over the versioned model price catalog. Prices here are
 * provider cost beliefs in USD - what a user pays is always this cost times
 * the published uniform markup, so this endpoint manages COGS data, never
 * markup. Append-only throughout: a reprice or revert is a NEW row.
 *
 * GET                       -> { rows } in force
 * GET ?history=<modelId>    -> { history } (audit trail, newest first)
 * POST { modelId, unit, pricing, note }        -> operator reprice
 * POST { modelId, unit, action: 'revert-to-seed' } -> hand the model back to
 *   seed management: appends the adapter literal's CURRENT rates (computed
 *   server-side) under the seed note, so boot seeding resumes versioning it.
 */
const RepriceBody = z.object({
  modelId: z.string().min(1),
  unit: z.enum(MODEL_PRICE_UNITS).default('per_token'),
  // strict(): reject unknown rate fields rather than silently stripping them
  // (a rate the schema does not know yet must fail loudly, not vanish with 200).
  pricing: z.record(z.string().regex(/^\d+$/, 'tier keys must be numeric token thresholds'), ModelPriceTier.strict()),
  note: z.string(),
});

/** Stable serialization for idempotency comparison (mirrors the seeder's normalizePricing). */
function normalizePricing(pricing: Record<string, Record<string, number | undefined>>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(pricing).sort()) {
    const tier = pricing[key];
    const normalized: Record<string, number> = {};
    for (const field of Object.keys(tier).sort()) {
      if (tier[field] !== undefined) normalized[field] = tier[field] as number;
    }
    out[key] = normalized;
  }
  return JSON.stringify(out);
}

const FAR_FUTURE = new Date('9999-01-01T00:00:00Z');

const RevertBody = z.object({
  modelId: z.string().min(1),
  unit: z.enum(MODEL_PRICE_UNITS).default('per_token'),
  action: z.literal('revert-to-seed'),
});

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    const history = req.query.history;
    if (typeof history === 'string' && history.length > 0) {
      return res.json({ history: await modelPriceRepository.historyForModel(history) });
    }
    return res.json({ rows: await modelPriceRepository.rowsInForce() });
  })
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    if ((req.body as { action?: string })?.action === 'revert-to-seed') {
      const parsed = RevertBody.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'invalid revert request');
      const { modelId, unit } = parsed.data;
      const entry = (await generateModelPriceSeed()).find(e => e.modelId === modelId && e.unit === unit);
      if (!entry) {
        throw new BadRequestError(`${modelId} (${unit}) is not seed-managed; nothing to revert to`);
      }
      const row = await modelPriceRepository.append({
        modelId,
        unit,
        pricing: entry.pricing,
        effectiveFrom: new Date(),
        note: SEED_NOTE,
      });
      return res.json({ row });
    }

    const parsed = RepriceBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'invalid reprice request');
    const { modelId, unit, pricing } = parsed.data;
    const note = parsed.data.note.trim();
    if (!note) throw new BadRequestError('note is required: it is the audit trail for this price change');
    if (note === SEED_NOTE) {
      throw new BadRequestError(
        `note '${SEED_NOTE}' is reserved for seed provenance; describe the source of the reprice`
      );
    }
    // 400-class validation here; append()'s own checks would surface as 500s.
    const hasNonzeroTier = Object.values(pricing).some(tier => tier.input > 0 || tier.output > 0);
    if (Object.keys(pricing).length === 0 || !hasNonzeroTier) {
      throw new BadRequestError('all-zero or empty pricing would settle calls free; mark the model freeToRun instead');
    }

    // Only models the catalog already knows (seeded or previously priced) can
    // be repriced: a typoed modelId must not mint a phantom in-force row.
    const [seedEntries, newestRows] = await Promise.all([
      generateModelPriceSeed(),
      modelPriceRepository.rowsInForce(FAR_FUTURE),
    ]);
    const knownModel =
      seedEntries.some(e => e.modelId === modelId && e.unit === unit) ||
      newestRows.some(r => r.modelId === modelId && r.unit === unit);
    if (!knownModel) {
      throw new BadRequestError(`unknown model ${modelId} (${unit}): reprice targets an existing catalog model`);
    }

    // Idempotency: a resubmit of the identical reprice (double-click, network
    // retry, second tab) returns the existing row instead of appending a
    // duplicate; the append-only audit trail must not record phantom changes.
    const newest = newestRows.find(r => r.modelId === modelId && r.unit === unit);
    if (newest && newest.note === note && normalizePricing(newest.pricing) === normalizePricing(pricing)) {
      return res.json({ row: newest });
    }

    const row = await modelPriceRepository.append({
      modelId,
      unit,
      pricing,
      effectiveFrom: new Date(),
      note,
    });
    return res.json({ row });
  });

export default handler;

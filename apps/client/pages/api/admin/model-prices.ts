import { createHash } from 'crypto';
import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { generateModelPriceSeed, modelPriceRepository, SEED_NOTE } from '@bike4mind/database';
import { DISCOVERY_PRICE_NOTE_PREFIX, MODEL_PRICE_UNITS, ModelPriceTier } from '@bike4mind/common';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';

/**
 * Admin surface over the versioned model price catalog. Prices here are
 * provider cost beliefs in USD - what a user pays is always this cost times
 * the published uniform markup, so this endpoint manages COGS data, never
 * markup. Append-only throughout: a reprice or revert is a NEW row.
 *
 * GET                       -> { rows } in force
 * GET ?history=<modelId>    -> { history } (audit trail, newest first)
 * POST { modelId, unit, pricing, note, confirm? } -> operator reprice
 *   (confirm is the token from a prior guardrail rejection; see confirmTokenFor)
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
  /**
   * Waiver token echoed back from a prior rejection's `confirmToken`. A string,
   * not a boolean: a blanket "yes" would waive every violation in the draft
   * while the operator was shown only the ones the rejection enumerated.
   */
  confirm: z.string().min(1).optional(),
});

/**
 * Largest fold-change a single manual reprice may apply to a rate's baseline
 * (the tier field in force, else the seed literal's) without an explicit
 * confirm. This editor is the only unguarded write
 * path into the billing catalog - discovery clamps its own moves
 * (modelDiscoveryPriceBandPct) and boot seeding only writes adapter literals -
 * and its failure mode is a magnitude slip: a $/1M figure typed into what is
 * stored as a per-single-token rate is 1e6 off, settles calls at that rate
 * immediately, and (being an operator row) is then immune to correction by
 * either automation.
 */
export const MANUAL_REPRICE_MAX_FACTOR = 10;

/**
 * Absolute ceiling, in USD per SINGLE token, on any per_token rate - the layer
 * that catches a magnitude slip with no baseline to compare against (a model
 * with nothing in force and nothing in the seed, a tier key the row does not
 * have yet, a rate field neither source carries).
 * The window it sits in: the priciest real rate in the catalog is $150 per 1M
 * ($1.5e-4 per token) and the cheapest is $0.0375 per 1M, whose 1e6 unit slip
 * lands at $37,500 per 1M. $10,000 per 1M (1e-2 per token) is therefore ~66x
 * above any real price yet ~3.75x below the smallest slip this endpoint can be
 * handed, so no real reprice trips it and every $/1M-typed-as-per-token slip
 * does. Non-token units are excluded: their rates are already per-unit human
 * scale, with no shared ceiling to pick.
 */
export const MANUAL_REPRICE_MAX_PER_TOKEN_USD = 1e-2;

/** Marks a guardrail rejection so the admin UI can offer a confirm affordance. */
export const MANUAL_REPRICE_BAND_ERROR_CODE = 'manual-reprice-over-band';

const TOKENS_PER_MILLION = 1_000_000;

const UNIT_LABEL: Record<string, string> = {
  per_token: 'per 1M tokens',
  per_minute: 'per minute',
  per_image: 'per image',
};

/** Symmetric fold-change, so a 10x raise and a 10x cut both read as 10; a move
 * from or to zero is unbounded (no ratio exists). */
const moveFactor = (a: number, b: number): number => {
  if (a === b) return 1;
  const lo = Math.min(a, b);
  return lo <= 0 ? Infinity : Math.max(a, b) / lo;
};

/** Locale-independent, so the rejection message reads the same everywhere. */
const readable = (value: number): string =>
  Number.isFinite(value) ? String(Number(value.toPrecision(4))) : 'unbounded';

/** Rates are quoted per 1M tokens; the other units are already per-unit. */
const forDisplay = (unit: string, rate: number): number => (unit === 'per_token' ? rate * TOKENS_PER_MILLION : rate);

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

type TierRates = Record<string, number | undefined>;

/**
 * Re-keys a tier map by the NUMERIC threshold. getTextModelCost selects a tier
 * through Number(key), so '0200000' and '200000' are one tier at read time and
 * must compare as one tier here - keyed by the raw string, a respelled key
 * silently misses its own baseline.
 */
function byNumericThreshold(pricing: Record<string, TierRates | undefined> | undefined): Map<number, TierRates> {
  const out = new Map<number, TierRates>();
  for (const [key, tier] of Object.entries(pricing ?? {})) {
    const threshold = Number(key);
    if (!Number.isFinite(threshold) || !tier) continue;
    out.set(threshold, tier);
  }
  return out;
}

/** One guardrail violation: `key` identifies the exact values shown to the
 * operator (it is what the confirm token digests), `message` is the line the
 * rejection enumerates. */
interface Finding {
  key: string;
  message: string;
}

/**
 * Binds a waiver to the exact draft the operator was shown. The digest covers
 * the whole submitted map plus every finding (each carrying its baseline), so
 * editing any rate - or the row in force moving underneath the operator -
 * makes the token stop matching here, not merely in the client. Not a secret
 * and not authentication (an admin can recompute it); it exists so one "apply
 * anyway" click cannot waive a violation that was never displayed.
 */
function confirmTokenFor(
  modelId: string,
  unit: string,
  pricing: Record<string, TierRates>,
  findings: Finding[]
): string {
  const canonical = [modelId, unit, normalizePricing(pricing), ...findings.map(f => f.key).sort()].join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
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

    // Deliberately ahead of, and exempt from, the reprice guardrails below:
    // the rates written here are the adapter literals computed server-side, so
    // a client cannot smuggle a magnitude slip through this branch, and a
    // literal that legitimately moved by more than the band must still be
    // revertible to.
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
        repricedBy: req.user.id,
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
    // An operator row wearing the discovery prefix would classify as an
    // automation row, which a newer price seed is allowed to supersede -
    // silently undoing a deliberate reprice that should be immune forever.
    if (note.startsWith(DISCOVERY_PRICE_NOTE_PREFIX)) {
      throw new BadRequestError(
        `note prefix '${DISCOVERY_PRICE_NOTE_PREFIX}' is reserved for discovery provenance; describe the source of the reprice`
      );
    }
    // 400-class validation here; append()'s own checks would surface as 500s.
    const hasNonzeroTier = Object.values(pricing).some(tier => tier.input > 0 || tier.output > 0);
    if (Object.keys(pricing).length === 0 || !hasNonzeroTier) {
      throw new BadRequestError('all-zero or empty pricing would settle calls free; mark the model freeToRun instead');
    }
    // Two spellings of one threshold ('0200000' and '200000') are one tier at
    // read time (Number()) but two independent keys in the stored map: the
    // respelled one dodges its baseline here and then shadows the real tier.
    const leadingZeroTier = Object.keys(pricing).find(key => key.length > 1 && key.startsWith('0'));
    if (leadingZeroTier) {
      throw new BadRequestError(
        `tier key '${leadingZeroTier}' has a leading zero; write the threshold as '${Number(leadingZeroTier)}' ` +
          'so one threshold has exactly one spelling in the map'
      );
    }

    // Only models the catalog already knows (seeded or previously priced) can
    // be repriced: a typoed modelId must not mint a phantom in-force row.
    const [seedEntries, newestRows] = await Promise.all([
      generateModelPriceSeed(),
      modelPriceRepository.rowsInForce(FAR_FUTURE),
    ]);
    const seedEntry = seedEntries.find(e => e.modelId === modelId && e.unit === unit);
    const knownModel = seedEntry !== undefined || newestRows.some(r => r.modelId === modelId && r.unit === unit);
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

    // Write guardrails. Three layers, because this is the only unguarded
    // operator write into the billing catalog and its rows are immune to
    // correction by discovery or by boot seeding:
    //   1. magnitude band against a baseline rate - the tier field in force,
    //      else the same model+unit's seed (adapter literal) tier field, so a
    //      field or a row that has never been priced still has a comparison;
    //   2. an absolute per-token ceiling, for a rate with no baseline anywhere;
    //   3. tier-ladder equality, since tierForTokens re-settles traffic onto a
    //      neighboring threshold when a tier appears or disappears.
    // Every layer reports rather than throws, so ONE rejection enumerates ALL
    // violations and the confirm token can cover exactly what was enumerated.
    // Tier maps are keyed numerically on both sides (see byNumericThreshold).
    // Tolerates a row that predates the pricing map rather than 500ing on it.
    const inForceTiers = byNumericThreshold(newest?.pricing);
    const seedTiers = byNumericThreshold(seedEntry?.pricing);
    const submittedTiers = byNumericThreshold(pricing);
    const findings: Finding[] = [];

    const baselineLadder = inForceTiers.size > 0 ? inForceTiers : seedTiers;
    if (baselineLadder.size > 0) {
      const added = [...submittedTiers.keys()].filter(t => !baselineLadder.has(t)).sort((a, b) => a - b);
      const dropped = [...baselineLadder.keys()].filter(t => !submittedTiers.has(t)).sort((a, b) => a - b);
      if (added.length > 0 || dropped.length > 0) {
        const parts = [
          added.length > 0 ? `adding tier ${added.join(', ')}` : '',
          dropped.length > 0 ? `dropping tier ${dropped.join(', ')}` : '',
        ].filter(Boolean);
        findings.push({
          key: `ladder|${added.join(',')}|${dropped.join(',')}`,
          message:
            `${modelId} tier ladder: ${parts.join(' and ')} - a prompt settles on the nearest remaining ` +
            'threshold, so traffic no rate in this draft touched gets repriced',
        });
      }
    }

    const ceilingLabel = `$${readable(forDisplay('per_token', MANUAL_REPRICE_MAX_PER_TOKEN_USD))} ${UNIT_LABEL.per_token}`;
    for (const [threshold, tier] of [...submittedTiers.entries()].sort((a, b) => a[0] - b[0])) {
      for (const field of Object.keys(tier).sort()) {
        const value = tier[field];
        if (typeof value !== 'number') continue;
        const baseline = inForceTiers.get(threshold)?.[field] ?? seedTiers.get(threshold)?.[field];
        const reasons: string[] = [];
        const keys: string[] = [];

        if (typeof baseline === 'number') {
          const factor = moveFactor(baseline, value);
          if (factor > MANUAL_REPRICE_MAX_FACTOR) {
            const move = Number.isFinite(factor)
              ? `is a ${readable(factor)}x move`
              : 'is an unbounded move (a zero rate has no ratio)';
            reasons.push(
              `$${readable(forDisplay(unit, baseline))} -> $${readable(forDisplay(unit, value))} ` +
                `${UNIT_LABEL[unit] ?? unit} ${move}, beyond the ${MANUAL_REPRICE_MAX_FACTOR}x manual reprice band`
            );
            keys.push(`band|${threshold}|${field}|${baseline}|${value}`);
          }
        }

        if (unit === 'per_token' && value > MANUAL_REPRICE_MAX_PER_TOKEN_USD) {
          reasons.push(
            typeof baseline === 'number'
              ? `it exceeds the ${ceilingLabel} absolute ceiling`
              : `$${readable(forDisplay(unit, value))} ${UNIT_LABEL[unit] ?? unit} has no rate in force and none in ` +
                  `the seed to compare against, and exceeds the ${ceilingLabel} absolute ceiling`
          );
          keys.push(`ceiling|${threshold}|${field}|${value}`);
        }

        if (reasons.length === 0) continue;
        findings.push({
          key: keys.join('+'),
          message: `${modelId} ${field} (tier ${threshold}): ${reasons.join(', and ')}`,
        });
      }
    }

    if (findings.length > 0) {
      const confirmToken = confirmTokenFor(modelId, unit, pricing, findings);
      if (parsed.data.confirm !== confirmToken) {
        const stale = parsed.data.confirm !== undefined;
        const lines = findings.map(f => `- ${f.message}`).join('\n');
        throw new BadRequestError(
          (stale
            ? 'the confirm token does not match this draft (a rate here, or the row in force, changed since the ' +
              'token was issued), so nothing was applied. '
            : '') +
            `${modelId} (${unit}): ${findings.length === 1 ? '1 change needs' : `${findings.length} changes need`} ` +
            `confirmation before it can settle calls:\n${lines}\n` +
            'review every line, then resubmit with confirm set to the confirmToken in this response to apply ' +
            'exactly these values.',
          { code: MANUAL_REPRICE_BAND_ERROR_CODE, confirmToken }
        );
      }
    }

    const row = await modelPriceRepository.append({
      modelId,
      unit,
      pricing,
      effectiveFrom: new Date(),
      note,
      repricedBy: req.user.id,
    });
    return res.json({ row });
  });

export default handler;

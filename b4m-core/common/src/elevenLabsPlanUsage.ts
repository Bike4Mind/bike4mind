import type { IProviderUnitsRow, UsageEventFeature, UsageEventStatus } from './types/entities/UsageEventTypes';

/**
 * ElevenLabs plan consumption: how our UsageEvent `units` convert to the vendor's own subscription credits, and the
 * cycle-to-date rollup the admin ElevenLabs usage view (GET /api/admin/elevenlabs-usage) shows against the plan.
 *
 * Vendor credits are ElevenLabs' quota unit, unrelated to Bike4Mind credits. Rates are from elevenlabs.io/pricing
 * and the ElevenLabs docs; keep them in step with voicePricing.ts (TTS USD rates), soundPricing.ts and
 * music/catalog.ts when the vendor reprices.
 */

/** Vendor credits per character of text to speech, by model. Flash/Turbo models cost half. */
export const ELEVENLABS_TTS_CREDITS_PER_CHARACTER: Readonly<Record<string, number>> = {
  eleven_v3: 1,
  eleven_multilingual_v2: 1,
  eleven_multilingual_v1: 1,
  eleven_monolingual_v1: 1,
  eleven_turbo_v2_5: 0.5,
  eleven_turbo_v2: 0.5,
  eleven_flash_v2_5: 0.5,
  eleven_flash_v2: 0.5,
};

/** An unlisted TTS model is counted at the full rate, so a new model never under-reports. */
const DEFAULT_TTS_CREDITS_PER_CHARACTER = 1;

/** Sound effects with a requested duration. */
export const ELEVENLABS_SOUND_CREDITS_PER_SECOND = 40;

/** Sound effects with no requested duration: a flat charge per generation (recorded as ELEVENLABS_DEFAULT_DURATION_SECONDS of units). */
export const ELEVENLABS_SOUND_AUTO_DURATION_CREDITS = 200;

/**
 * Music. ESTIMATE: the vendor publishes ~900 credits per minute on one pricing page only, and has not confirmed it
 * for API use. Reconcile against the vendor dashboard before relying on it.
 */
export const ELEVENLABS_MUSIC_CREDITS_PER_SECOND = 900 / 60;

/**
 * Conversational agents are billed by call minute against a separate minute allowance, not the credit pool.
 * ESTIMATE of provider cost: the published overage rate per minute, used as the usage event's costUsd.
 */
export const ELEVENLABS_AGENT_USD_PER_MINUTE = 0.08;

export const ELEVENLABS_PRODUCTS = ['text_to_speech', 'sound_effects', 'music_generation', 'agents'] as const;
export type ElevenLabsProduct = (typeof ELEVENLABS_PRODUCTS)[number];

const PRODUCT_OF_FEATURE: Partial<Record<UsageEventFeature, ElevenLabsProduct>> = {
  text_to_speech: 'text_to_speech',
  sound_effects: 'sound_effects',
  music_generation: 'music_generation',
  voice: 'agents',
};

export const elevenLabsProductOf = (feature: UsageEventFeature): ElevenLabsProduct | null =>
  PRODUCT_OF_FEATURE[feature] ?? null;

/**
 * Vendor credits for one providerUnitsBreakdown bucket of a product: `units` (characters for TTS, seconds otherwise)
 * over `requests` calls. Agents draw minutes, not credits, so they convert to 0. `atDefaultUnits` marks a bucket of
 * auto-duration sound effects (queried with defaultUnits ELEVENLABS_DEFAULT_DURATION_SECONDS), priced per generation.
 */
export function elevenLabsVendorCredits(
  product: ElevenLabsProduct,
  bucket: { model: string; units: number; requests: number; atDefaultUnits: boolean }
): number {
  switch (product) {
    case 'text_to_speech':
      return bucket.units * (ELEVENLABS_TTS_CREDITS_PER_CHARACTER[bucket.model] ?? DEFAULT_TTS_CREDITS_PER_CHARACTER);
    case 'sound_effects':
      return bucket.atDefaultUnits
        ? bucket.requests * ELEVENLABS_SOUND_AUTO_DURATION_CREDITS
        : bucket.units * ELEVENLABS_SOUND_CREDITS_PER_SECOND;
    case 'music_generation':
      return bucket.units * ELEVENLABS_MUSIC_CREDITS_PER_SECOND;
    case 'agents':
      return 0;
  }
}

/**
 * Failed and timed-out calls charged the user nothing, but the vendor may still have billed them (a call whose outcome
 * is unknown, or a song generated and then lost), so they are reported apart as an upper bound, never in the total.
 */
const POSSIBLY_BILLED_STATUSES: ReadonlySet<UsageEventStatus> = new Set(['error', 'timeout']);
/**
 * The rows cannot tell a lost song from a rejected call (the music route also records a 429 as 'error'), hence an
 * upper bound. Failed sound effects are left out: their producer records only calls that yielded nothing billable
 * (soundEffectJobHandler recordFailedCall).
 */
const isPossiblyBilled = (product: ElevenLabsProduct) => product !== 'sound_effects';

/** How many closed cycles the admin view reaches back, for reconciling one against the vendor dashboard. */
export const ELEVENLABS_MAX_CYCLES_BACK = 12;

const cycleContaining = (now: Date, startDay: number): { from: Date; to: Date } => {
  const cycleStart = (year: number, month: number) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(startDay, lastDay)));
  };
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const thisMonth = cycleStart(year, month);
  return now >= thisMonth
    ? { from: thisMonth, to: cycleStart(year, month + 1) }
    : { from: cycleStart(year, month - 1), to: thisMonth };
};

/**
 * The UTC billing cycle [from, to) of a plan renewing on `startDay` (clamped to the last day of a short month):
 * the one containing `now`, or `cyclesBack` cycles before it.
 */
export function elevenLabsBillingCycle(now: Date, startDay: number, cyclesBack = 0): { from: Date; to: Date } {
  let cycle = cycleContaining(now, startDay);
  for (let i = 0; i < cyclesBack; i++) cycle = cycleContaining(new Date(cycle.from.getTime() - 1), startDay);
  return cycle;
}

export type ElevenLabsUsageTotals = {
  requests: number;
  /** Vendor credits drawn from the plan's credit pool by successful calls. */
  credits: number;
  /** Agent call minutes. */
  agentMinutes: number;
  failedRequests: number;
  /** Vendor credits of failed calls the vendor may have billed: an upper bound, not part of `credits`. */
  possiblyBilledCredits: number;
};

export type ElevenLabsProductUsage = ElevenLabsUsageTotals & { product: ElevenLabsProduct };
export type ElevenLabsModelUsage = ElevenLabsUsageTotals & {
  product: ElevenLabsProduct;
  model: string;
  /** Characters for text to speech, seconds otherwise; every status, failed calls included. */
  units: number;
};
export type ElevenLabsUserUsage = ElevenLabsUsageTotals & { userId: string; userLabel?: string };
export type ElevenLabsDayUsage = ElevenLabsUsageTotals & { day: string };

export type ElevenLabsPlanUsage = {
  cycle: { from: string; to: string; startDay: number };
  /** null when the allowance setting is 0 (not configured). */
  plan: { monthlyCredits: number | null; agentMinutes: number | null };
  /** Calls on the platform key, which draw down the plan. Includes rows with no recorded key source. */
  platform: ElevenLabsUsageTotals;
  /** Calls on users' own ElevenLabs keys, billed to their accounts and excluded from every breakdown. */
  userKeys: ElevenLabsUsageTotals;
  /** Platform-key requests with no recorded key source: rows written before it was recorded, or whose key lookup failed. */
  unknownKeySourceRequests: number;
  byProduct: ElevenLabsProductUsage[];
  byModel: ElevenLabsModelUsage[];
  byUser: ElevenLabsUserUsage[];
  byDay: ElevenLabsDayUsage[];
};

const emptyTotals = (): ElevenLabsUsageTotals => ({
  requests: 0,
  credits: 0,
  agentMinutes: 0,
  failedRequests: 0,
  possiblyBilledCredits: 0,
});

const addRow = (totals: ElevenLabsUsageTotals, product: ElevenLabsProduct, row: IProviderUnitsRow) => {
  const credits = elevenLabsVendorCredits(product, row);
  totals.requests += row.requests;
  if (POSSIBLY_BILLED_STATUSES.has(row.status)) {
    totals.failedRequests += row.requests;
    if (isPossiblyBilled(product)) totals.possiblyBilledCredits += credits;
    return;
  }
  totals.credits += credits;
  if (product === 'agents') totals.agentMinutes += row.units / 60;
};

const bucketed = <K extends string, T>(make: (key: K) => T) => {
  const buckets = new Map<K, T>();
  return {
    get(key: K): T {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = make(key);
        buckets.set(key, bucket);
      }
      return bucket;
    },
    values: () => [...buckets.values()],
  };
};

const byCreditsDesc = (a: ElevenLabsUsageTotals, b: ElevenLabsUsageTotals) =>
  b.credits - a.credits || b.agentMinutes - a.agentMinutes || b.requests - a.requests;

/** Roll providerUnitsBreakdown rows (provider 'elevenlabs') up into the plan view. */
export function summarizeElevenLabsPlanUsage(
  rows: IProviderUnitsRow[],
  params: { cycle: { from: Date; to: Date }; startDay: number; monthlyCredits: number; agentMinutes: number }
): ElevenLabsPlanUsage {
  const platform = emptyTotals();
  const userKeys = emptyTotals();
  let unknownKeySourceRequests = 0;
  const products = bucketed<ElevenLabsProduct, ElevenLabsProductUsage>(product => ({ product, ...emptyTotals() }));
  const models = bucketed<string, ElevenLabsModelUsage>(() => ({
    product: 'text_to_speech',
    model: '',
    units: 0,
    ...emptyTotals(),
  }));
  const users = bucketed<string, ElevenLabsUserUsage>(userId => ({ userId, ...emptyTotals() }));
  const days = bucketed<string, ElevenLabsDayUsage>(day => ({ day, ...emptyTotals() }));

  for (const row of rows) {
    const product = elevenLabsProductOf(row.feature);
    if (!product) continue;
    if (row.keySource === 'user') {
      addRow(userKeys, product, row);
      continue;
    }
    if (row.keySource === null) unknownKeySourceRequests += row.requests;
    addRow(platform, product, row);
    addRow(products.get(product), product, row);
    const model = models.get(`${product}\u0000${row.model}`);
    model.product = product;
    model.model = row.model;
    model.units += row.units;
    addRow(model, product, row);
    if (row.userId) addRow(users.get(row.userId), product, row);
    addRow(days.get(row.day), product, row);
  }

  return {
    cycle: { from: params.cycle.from.toISOString(), to: params.cycle.to.toISOString(), startDay: params.startDay },
    plan: {
      monthlyCredits: params.monthlyCredits > 0 ? params.monthlyCredits : null,
      agentMinutes: params.agentMinutes > 0 ? params.agentMinutes : null,
    },
    platform,
    userKeys,
    unknownKeySourceRequests,
    byProduct: products.values().sort(byCreditsDesc),
    byModel: models.values().sort(byCreditsDesc),
    byUser: users.values().sort(byCreditsDesc),
    byDay: days.values().sort((a, b) => a.day.localeCompare(b.day)),
  };
}

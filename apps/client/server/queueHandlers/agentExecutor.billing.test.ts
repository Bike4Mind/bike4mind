/**
 * Unit coverage for per-iteration billing + the #657 context-window guard.
 *
 * The guard (`agentExecutor.billing.ts`) previously had zero tests: a mutation
 * that dropped the anti-over-bill check left the whole agent-executor suite
 * green. These tests pin which effects fire on each path (bill / guard-trip /
 * no-op) so a regression is caught here rather than in a production ledger.
 */
import { describe, it, expect, vi } from 'vitest';
import { billIteration, type BillingCounters, type IterationBillingEffects } from './agentExecutor.billing';
import type { ModelInfo } from '@bike4mind/common';

// input rate = 1, everything else 0, so `getTextModelCost` reduces to
// `1 * inputTokens` and cost math in the assertions stays trivial.
function makeModelInfo(contextWindow: number): ModelInfo {
  return {
    id: 'test-model',
    type: 'text',
    name: 'Test Model',
    backend: 'anthropic',
    contextWindow,
    max_tokens: 4096,
    supportsImageVariation: false,
    pricing: { [Number.MAX_SAFE_INTEGER]: { input: 1, output: 0, cache_read: 0, cache_write: 0 } },
  } as ModelInfo;
}

function makeCounters(overrides: Partial<BillingCounters> = {}): BillingCounters {
  return {
    cumulativeCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

function makeEffects(usdToCredits: (usd: number) => number = usd => usd): {
  effects: IterationBillingEffects;
  spies: {
    deductCredits: ReturnType<typeof vi.fn>;
    recordUsageEvent: ReturnType<typeof vi.fn>;
    addIterationBilling: ReturnType<typeof vi.fn>;
    sendProgress: ReturnType<typeof vi.fn>;
    logGuardTrip: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    deductCredits: vi.fn(async () => {}),
    recordUsageEvent: vi.fn(),
    addIterationBilling: vi.fn(async () => {}),
    sendProgress: vi.fn(async () => {}),
    logGuardTrip: vi.fn(),
  };
  return {
    spies,
    effects: {
      ...spies,
      usdToCredits,
      now: () => 1000,
    },
  };
}

const checkpoint = (
  inputTokens: number,
  rest: Partial<Record<'output' | 'cacheRead' | 'cacheWrite', number>> = {}
) => ({
  totalInputTokens: inputTokens,
  totalOutputTokens: rest.output ?? 0,
  totalCacheReadTokens: rest.cacheRead ?? 0,
  totalCacheWriteTokens: rest.cacheWrite ?? 0,
});

describe('billIteration (#657 context-window guard)', () => {
  it('non-trip: deducts, records a usage event, persists billing, and sends progress exactly once', async () => {
    const counters = makeCounters();
    const { effects, spies } = makeEffects();

    await billIteration({
      iterationIndex: 1,
      checkpoint: checkpoint(100, { output: 20 }),
      counters,
      modelInfo: makeModelInfo(1000),
      model: 'test-model',
      startTime: 0,
      effects,
    });

    expect(spies.logGuardTrip).not.toHaveBeenCalled();
    expect(spies.deductCredits).toHaveBeenCalledTimes(1);
    expect(spies.deductCredits).toHaveBeenCalledWith(expect.objectContaining({ credits: 100, inputTokens: 100 }));
    expect(spies.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(spies.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ok', costUsd: 100, creditsCharged: 100, inputTokens: 100, latencyMs: 1000 })
    );
    expect(spies.addIterationBilling).toHaveBeenCalledTimes(1);
    expect(spies.addIterationBilling).toHaveBeenCalledWith(
      expect.objectContaining({ iteration: 1, inputTokens: 100, credits: 100 })
    );
    expect(spies.sendProgress).toHaveBeenCalledTimes(1);
    // Counters advance to the checkpoint so later iterations settle from here.
    expect(counters).toMatchObject({ cumulativeCost: 100, inputTokens: 100, outputTokens: 20 });
  });

  it('trip: skips the charge but still persists a credits:0 billing record and advances counters', async () => {
    const counters = makeCounters();
    const { effects, spies } = makeEffects();

    await billIteration({
      iterationIndex: 3,
      checkpoint: checkpoint(2000), // > contextWindow 1000
      counters,
      modelInfo: makeModelInfo(1000),
      model: 'test-model',
      startTime: 0,
      effects,
    });

    expect(spies.logGuardTrip).toHaveBeenCalledWith({ inputTokensDelta: 2000, contextWindow: 1000 });
    // No ledger deduction and no progress event on trip.
    expect(spies.deductCredits).not.toHaveBeenCalled();
    expect(spies.sendProgress).not.toHaveBeenCalled();
    // The billing record MUST still be written (credits:0) or a Lambda resume
    // reseeds counters short of this jump and the guard re-fires forever,
    // silently dropping one real charge per resume boundary.
    expect(spies.addIterationBilling).toHaveBeenCalledTimes(1);
    expect(spies.addIterationBilling).toHaveBeenCalledWith(
      expect.objectContaining({ iteration: 3, inputTokens: 2000, credits: 0 })
    );
    // Usage event is recorded as an anomaly marker with zeroed cost/tokens so
    // COGS/margin sums (which $sum costUsd with no status filter) stay clean.
    expect(spies.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(spies.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', costUsd: 0, creditsCharged: 0, inputTokens: 0 })
    );
    // Counters still advance to the (corrupt) checkpoint so resumes reconcile.
    expect(counters).toMatchObject({ cumulativeCost: 2000, inputTokens: 2000 });
  });

  it('boundary: an input delta exactly equal to the context window bills (not > window)', async () => {
    const counters = makeCounters();
    const { effects, spies } = makeEffects();

    await billIteration({
      iterationIndex: 1,
      checkpoint: checkpoint(1000), // === contextWindow
      counters,
      modelInfo: makeModelInfo(1000),
      model: 'test-model',
      startTime: 0,
      effects,
    });

    expect(spies.logGuardTrip).not.toHaveBeenCalled();
    expect(spies.deductCredits).toHaveBeenCalledTimes(1);
    expect(spies.addIterationBilling).toHaveBeenCalledWith(expect.objectContaining({ credits: 1000 }));
  });

  it('boundary: a non-positive context window disables the guard (bills even a huge delta)', async () => {
    const counters = makeCounters();
    const { effects, spies } = makeEffects();

    await billIteration({
      iterationIndex: 1,
      checkpoint: checkpoint(5_000_000),
      counters,
      modelInfo: makeModelInfo(0), // contextWindow <= 0 -> guard off
      model: 'test-model',
      startTime: 0,
      effects,
    });

    expect(spies.logGuardTrip).not.toHaveBeenCalled();
    expect(spies.deductCredits).toHaveBeenCalledTimes(1);
    expect(spies.addIterationBilling).toHaveBeenCalledWith(expect.objectContaining({ credits: 5_000_000 }));
  });

  it('no-op: a non-positive cost delta bills nothing and leaves counters untouched', async () => {
    const counters = makeCounters({ cumulativeCost: 100, inputTokens: 100 });
    const { effects, spies } = makeEffects();

    await billIteration({
      iterationIndex: 2,
      checkpoint: checkpoint(100), // same cumulative -> costDelta 0
      counters,
      modelInfo: makeModelInfo(1000),
      model: 'test-model',
      startTime: 0,
      effects,
    });

    expect(spies.deductCredits).not.toHaveBeenCalled();
    expect(spies.recordUsageEvent).not.toHaveBeenCalled();
    expect(spies.addIterationBilling).not.toHaveBeenCalled();
    expect(spies.sendProgress).not.toHaveBeenCalled();
    expect(counters).toMatchObject({ cumulativeCost: 100, inputTokens: 100 });
  });

  it('sub-credit settlement: skips the ledger deduction but still records COGS + billing', async () => {
    const counters = makeCounters();
    // usdToCredits rounds a small delta to 0 credits.
    const { effects, spies } = makeEffects(() => 0);

    await billIteration({
      iterationIndex: 1,
      checkpoint: checkpoint(100),
      counters,
      modelInfo: makeModelInfo(1000),
      model: 'test-model',
      startTime: 0,
      effects,
    });

    expect(spies.deductCredits).not.toHaveBeenCalled();
    // COGS still recorded so margin reporting doesn't under-count cost.
    expect(spies.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ok', costUsd: 100, creditsCharged: 0 })
    );
    expect(spies.addIterationBilling).toHaveBeenCalledWith(expect.objectContaining({ credits: 0 }));
    expect(spies.sendProgress).toHaveBeenCalledTimes(1);
  });

  it('cross-iteration: deltas are computed against the running counters, not the raw checkpoint', async () => {
    const counters = makeCounters();
    const { effects, spies } = makeEffects();
    const modelInfo = makeModelInfo(10_000);

    await billIteration({
      iterationIndex: 1,
      checkpoint: checkpoint(1000),
      counters,
      modelInfo,
      model: 'test-model',
      startTime: 0,
      effects,
    });
    await billIteration({
      iterationIndex: 2,
      checkpoint: checkpoint(3500), // cumulative
      counters,
      modelInfo,
      model: 'test-model',
      startTime: 0,
      effects,
    });

    // Second iteration's delta is 3500 - 1000 = 2500, NOT the raw 3500.
    expect(spies.addIterationBilling).toHaveBeenNthCalledWith(2, expect.objectContaining({ inputTokens: 2500 }));
    expect(counters.inputTokens).toBe(3500);
  });
});

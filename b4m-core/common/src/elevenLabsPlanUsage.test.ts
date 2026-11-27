import { describe, expect, it } from 'vitest';
import {
  elevenLabsBillingCycle,
  elevenLabsVendorCredits,
  ELEVENLABS_MUSIC_CREDITS_PER_SECOND,
  summarizeElevenLabsPlanUsage,
} from './elevenLabsPlanUsage';
import type { IProviderUnitsRow } from './types/entities/UsageEventTypes';

const row = (overrides: Partial<IProviderUnitsRow>): IProviderUnitsRow => ({
  day: '2026-03-02',
  feature: 'text_to_speech',
  model: 'eleven_multilingual_v2',
  userId: 'u1',
  keySource: 'platform',
  status: 'ok',
  atDefaultUnits: false,
  requests: 1,
  units: 0,
  ...overrides,
});

const cycle = { from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z') };
const summarize = (rows: IProviderUnitsRow[], plan = { monthlyCredits: 100_000, agentMinutes: 300 }) =>
  summarizeElevenLabsPlanUsage(rows, { cycle, startDay: 1, ...plan });

describe('elevenLabsVendorCredits', () => {
  const bucket = (model: string, units: number, requests = 1, atDefaultUnits = false) => ({
    model,
    units,
    requests,
    atDefaultUnits,
  });

  it('charges a character per credit on multilingual and v3 models, half on flash and turbo', () => {
    expect(elevenLabsVendorCredits('text_to_speech', bucket('eleven_multilingual_v2', 1000))).toBe(1000);
    expect(elevenLabsVendorCredits('text_to_speech', bucket('eleven_v3', 1000))).toBe(1000);
    expect(elevenLabsVendorCredits('text_to_speech', bucket('eleven_flash_v2_5', 1000))).toBe(500);
    expect(elevenLabsVendorCredits('text_to_speech', bucket('eleven_turbo_v2_5', 1000))).toBe(500);
  });

  it('counts an unlisted TTS model at the full rate', () => {
    expect(elevenLabsVendorCredits('text_to_speech', bucket('eleven_future_v9', 10))).toBe(10);
  });

  it('prices sound effects per second, and an auto-duration bucket per generation', () => {
    expect(elevenLabsVendorCredits('sound_effects', bucket('elevenlabs', 5))).toBe(200);
    expect(elevenLabsVendorCredits('sound_effects', bucket('elevenlabs', (200 / 11) * 3, 3, true))).toBe(600);
  });

  it('prices music per second at the estimated rate, and agents at no credits', () => {
    expect(elevenLabsVendorCredits('music_generation', bucket('music_v1', 60))).toBe(
      60 * ELEVENLABS_MUSIC_CREDITS_PER_SECOND
    );
    expect(elevenLabsVendorCredits('agents', bucket('elevenlabs', 600))).toBe(0);
  });
});

describe('elevenLabsBillingCycle', () => {
  it("runs from this month's start day when it has passed", () => {
    const { from, to } = elevenLabsBillingCycle(new Date('2026-03-20T10:00:00Z'), 15);
    expect(from.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-04-15T00:00:00.000Z');
  });

  it("runs from last month's start day before this month's", () => {
    const { from, to } = elevenLabsBillingCycle(new Date('2026-03-10T10:00:00Z'), 15);
    expect(from.toISOString()).toBe('2026-02-15T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('clamps a late start day to the end of a short month', () => {
    const { from, to } = elevenLabsBillingCycle(new Date('2026-03-05T00:00:00Z'), 31);
    expect(from.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('steps back whole cycles', () => {
    // Current cycle is Feb 28 to Mar 31, so two back is Dec 31 to Jan 31.
    const { from, to } = elevenLabsBillingCycle(new Date('2026-03-20T10:00:00Z'), 31, 2);
    expect(from.toISOString()).toBe('2025-12-31T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('crosses a year boundary', () => {
    const { from, to } = elevenLabsBillingCycle(new Date('2026-01-02T00:00:00Z'), 5);
    expect(from.toISOString()).toBe('2025-12-05T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });
});

describe('summarizeElevenLabsPlanUsage', () => {
  it('totals platform-key credits and agent minutes, keeping user-key calls out of every breakdown', () => {
    const summary = summarize([
      row({ units: 1000 }),
      row({ units: 400, keySource: 'user', userId: 'u2' }),
      row({ feature: 'voice', model: 'elevenlabs', units: 180 }),
    ]);

    expect(summary.platform).toMatchObject({ requests: 2, credits: 1000, agentMinutes: 3 });
    expect(summary.userKeys).toMatchObject({ requests: 1, credits: 400 });
    expect(summary.byUser.map(u => u.userId)).toEqual(['u1']);
    expect(summary.byProduct.map(p => p.product)).toEqual(['text_to_speech', 'agents']);
  });

  it('reports failed calls as possibly billed, apart from the credit total', () => {
    const summary = summarize([
      row({ feature: 'music_generation', model: 'music_v1', units: 60 }),
      row({ feature: 'music_generation', model: 'music_v1', units: 30, status: 'error' }),
      row({ feature: 'music_generation', model: 'music_v1', units: 30, status: 'timeout' }),
    ]);

    expect(summary.platform.credits).toBe(900);
    expect(summary.platform).toMatchObject({ failedRequests: 2, possiblyBilledCredits: 900 });
  });

  it('counts a failed sound effect as failed but not possibly billed', () => {
    const summary = summarize([row({ feature: 'sound_effects', model: 'elevenlabs', units: 5, status: 'error' })]);
    expect(summary.platform).toMatchObject({ failedRequests: 1, possiblyBilledCredits: 0, credits: 0 });
  });

  it('counts a refused but billed call as used credits', () => {
    const summary = summarize([row({ feature: 'music_generation', model: 'music_v1', units: 60, status: 'refusal' })]);
    expect(summary.platform.credits).toBe(900);
  });

  it('counts rows with no recorded key source against the plan and reports them', () => {
    const summary = summarize([row({ units: 10, keySource: null, requests: 4 })]);
    expect(summary.platform.credits).toBe(10);
    expect(summary.unknownKeySourceRequests).toBe(4);
  });

  it('breaks usage down by model with its raw units, by user and by ascending day', () => {
    const summary = summarize([
      row({ day: '2026-03-03', units: 100 }),
      row({ day: '2026-03-02', units: 300, userId: 'u2' }),
      row({ day: '2026-03-02', model: 'eleven_flash_v2_5', units: 100 }),
    ]);

    expect(summary.byModel).toEqual([
      expect.objectContaining({ product: 'text_to_speech', model: 'eleven_multilingual_v2', units: 400, credits: 400 }),
      expect.objectContaining({ model: 'eleven_flash_v2_5', units: 100, credits: 50 }),
    ]);
    expect(summary.byUser).toEqual([
      expect.objectContaining({ userId: 'u2', credits: 300 }),
      expect.objectContaining({ userId: 'u1', credits: 150 }),
    ]);
    expect(summary.byDay.map(d => [d.day, d.credits])).toEqual([
      ['2026-03-02', 350],
      ['2026-03-03', 100],
    ]);
  });

  it('treats a zero allowance as not configured and reports the cycle', () => {
    const summary = summarize([], { monthlyCredits: 0, agentMinutes: 0 });
    expect(summary.plan).toEqual({ monthlyCredits: null, agentMinutes: null });
    expect(summary.cycle).toEqual({ from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z', startDay: 1 });
  });

  it('ignores features ElevenLabs does not bill against the plan', () => {
    const summary = summarize([row({ feature: 'chat', units: 1000 })]);
    expect(summary.platform.requests).toBe(0);
  });
});

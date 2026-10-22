import { beforeEach, describe, it, expect, vi } from 'vitest';
import { CREDITS_PER_USD_COST } from '@bike4mind/common';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { estimateAudioCredits } from '../../audioCost';

// The real stochastic rounding, with its draw pinned so the reserved charge is assertable.
const { settlementDraw } = vi.hoisted(() => ({ settlementDraw: vi.fn(() => 0.5) }));
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return {
    ...actual,
    usdToCreditsStochastic: (usd: number) => actual.usdToCreditsStochastic(usd, () => settlementDraw()),
  };
});
// Wrapped so a test can price one call off-table (the speech and sfx rates never land on a half credit).
vi.mock('../../audioCost', async importOriginal => {
  const actual = await importOriginal<typeof import('../../audioCost')>();
  return { ...actual, estimateAudioCredits: vi.fn(actual.estimateAudioCredits) };
});
beforeEach(() => {
  settlementDraw.mockReturnValue(0.5);
});
const usdFor = (credits: number) => credits / CREDITS_PER_USD_COST;

// Drives the real audio_generation credit branches (gateAudioCredits / settleAudioCredits)
// that ToolBuilder's onToolStart/onToolFinish delegate to, against a fake toolCreditsMap and
// quest - covering reserve-on-success, the enforceCredits short-circuit, and the affordability
// gate end to end. Mirrors ToolBuilder.musicCredits.test.ts.

const speechCost = estimateAudioCredits({
  kind: 'speech',
  provider: 'openai',
  model: 'tts-1',
  characters: 1000,
}).requiredCredits;
const sfxCost = estimateAudioCredits({
  kind: 'sound_effect',
  provider: 'elevenlabs',
  durationSeconds: 5,
}).requiredCredits;

const makeBuilder = ({
  credits = 1_000_000,
  hasCreditStore = true,
}: { credits?: number; hasCreditStore?: boolean } = {}) => {
  const toolCreditsMap = new Map<string, number[]>();
  const toolCreditModels = new Set<string>();
  const record = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
  const deps = {
    user: { id: 'u1', currentCredits: credits },
    logger,
    db: {
      creditTransactions: hasCreditStore ? {} : undefined,
      usageEvents: { record },
    },
    toolCreditsMap,
    toolCreditModels,
  } as unknown as ToolBuilderConfig;
  return { builder: new ToolBuilder(deps), toolCreditsMap, toolCreditModels, record };
};

const quest = () => ({ id: 'q1', sessionId: 's1', creditsUsed: 0, images: [] as string[] }) as never;
const speechFinish = (path: string) =>
  ({ kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000, paths: [path] }) as const;
const sfxFinish = (path: string) =>
  ({ kind: 'sound_effect', provider: 'elevenlabs', durationSeconds: 5, paths: [path] }) as const;

describe('ToolBuilder audio credit branches', () => {
  it('gates each call against the balance left after the calls before it in the turn', () => {
    // Room for one clip, not two: the second must be refused whether the first is still running
    // or has already settled, since the balance snapshot predates both.
    const { builder } = makeBuilder({ credits: Math.floor(speechCost * 1.5) });
    const input = { kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000 } as const;

    builder.gateAudioCredits(input, true);
    expect(() => builder.gateAudioCredits(input, true)).toThrow(/enough personal credits/);

    builder.settleAudioCredits(quest(), speechFinish('a.mp3'), true);
    expect(() => builder.gateAudioCredits(input, true)).toThrow(/enough personal credits/);
  });

  it('settle reserves exactly one charge per delivered clip and rides the path on quest.images', () => {
    const { builder, toolCreditsMap, record } = makeBuilder();
    const q = quest();
    builder.settleAudioCredits(q, speechFinish('a.mp3'), true);
    expect(toolCreditsMap.get('audio_generation')).toEqual([speechCost]);
    expect(q.creditsUsed).toBe(speechCost);
    expect(q.images).toEqual(['a.mp3']);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('tags each clip with the feature its direct endpoint writes: sound_effects or text_to_speech', () => {
    // The Gears status unlocks its sound gear from sound_effects; a 'tool' row would not count.
    const { builder, record } = makeBuilder();
    builder.settleAudioCredits(quest(), sfxFinish('b.mp3'), true);
    builder.settleAudioCredits(quest(), speechFinish('a.mp3'), true);
    expect(record).toHaveBeenNthCalledWith(1, expect.objectContaining({ feature: 'sound_effects' }));
    expect(record).toHaveBeenNthCalledWith(2, expect.objectContaining({ feature: 'text_to_speech' }));
  });

  it('settle reserves each call independently so speech + sfx sum, not double the later cost', () => {
    const { builder, toolCreditsMap } = makeBuilder();
    const q = quest();
    builder.settleAudioCredits(q, speechFinish('a.mp3'), true);
    builder.settleAudioCredits(q, sfxFinish('b.mp3'), true);
    expect(toolCreditsMap.get('audio_generation')).toEqual([speechCost, sfxCost]);
    expect(speechCost).not.toBe(sfxCost);
    expect(q.creditsUsed).toBe(speechCost + sfxCost);
  });

  it('settle skips the reservation and usage event when enforceCredits is off, but still delivers the clip', () => {
    const { builder, toolCreditsMap, record } = makeBuilder();
    const q = quest();
    builder.settleAudioCredits(q, speechFinish('a.mp3'), false);
    expect(toolCreditsMap.has('audio_generation')).toBe(false);
    expect(q.creditsUsed).toBe(0);
    expect(record).not.toHaveBeenCalled();
    expect(q.images).toEqual(['a.mp3']);
  });

  it('settle reserves nothing when the credit store is unavailable', () => {
    const { builder, toolCreditsMap } = makeBuilder({ hasCreditStore: false });
    const q = quest();
    builder.settleAudioCredits(q, speechFinish('a.mp3'), true);
    expect(toolCreditsMap.has('audio_generation')).toBe(false);
    expect(q.images).toEqual(['a.mp3']);
  });

  it('gate throws insufficient_credits before generation when the owner cannot cover the charge', () => {
    const { builder, toolCreditsMap } = makeBuilder({ credits: 0 });
    expect(() =>
      builder.gateAudioCredits({ kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000 }, true)
    ).toThrow();
    // The gate never reserves - only settle (reached on success) does.
    expect(toolCreditsMap.has('audio_generation')).toBe(false);
  });

  it('gate is a no-op when enforceCredits is off, even with zero balance', () => {
    const { builder } = makeBuilder({ credits: 0 });
    expect(() =>
      builder.gateAudioCredits({ kind: 'sound_effect', provider: 'elevenlabs', durationSeconds: 5 }, false)
    ).not.toThrow();
  });

  it('gate does not throw when the owner can afford the charge', () => {
    const { builder, toolCreditsMap } = makeBuilder({ credits: 1_000_000 });
    expect(() =>
      builder.gateAudioCredits({ kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000 }, true)
    ).not.toThrow();
    expect(toolCreditsMap.has('audio_generation')).toBe(false);
  });
});

describe('ToolBuilder audio charge rounding', () => {
  it.each([
    [0.25, 41],
    [0.75, 40],
  ])('settle charges N or N+1 for a cost of N + 0.5 credits (draw %s -> %s)', (draw, expected) => {
    settlementDraw.mockReturnValue(draw);
    vi.mocked(estimateAudioCredits).mockReturnValueOnce({ requiredCredits: 41, usdCost: usdFor(40.5), units: 1000 });
    const { builder, toolCreditsMap, record } = makeBuilder();
    const q = quest();

    builder.settleAudioCredits(q, speechFinish('a.mp3'), true);

    expect(toolCreditsMap.get('audio_generation')).toEqual([expected]);
    expect(q.creditsUsed).toBe(expected);
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: expected });
  });

  it('settle can charge 0 for a tiny clip: it is still delivered and its usage event written, with no charging model', () => {
    vi.mocked(estimateAudioCredits).mockReturnValueOnce({ requiredCredits: 1, usdCost: 0.00001, units: 3 });
    const { builder, toolCreditsMap, toolCreditModels, record } = makeBuilder();
    const q = quest();

    builder.settleAudioCredits(q, speechFinish('a.mp3'), true);

    expect(toolCreditsMap.get('audio_generation')).toEqual([0]);
    expect(q.creditsUsed).toBe(0);
    expect(q.images).toEqual(['a.mp3']);
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0, costUsd: 0.00001 });
    expect(toolCreditModels.size).toBe(0);
  });

  it('gate still requires the round-up: 40 credits cannot start a call whose charge is 40 or 41', () => {
    const input = { kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000 } as const;
    const priced = { requiredCredits: 41, usdCost: usdFor(40.5), units: 1000 };
    vi.mocked(estimateAudioCredits).mockReturnValueOnce(priced).mockReturnValueOnce(priced);

    expect(() => makeBuilder({ credits: 40 }).builder.gateAudioCredits(input, true)).toThrow();
    expect(() => makeBuilder({ credits: 41 }).builder.gateAudioCredits(input, true)).not.toThrow();
  });
});

describe('ToolBuilder audio ledger model attribution', () => {
  it('records the resolved speech model, and qualifies a sound effect by provider', () => {
    const { builder, toolCreditModels } = makeBuilder();
    const q = quest();
    builder.settleAudioCredits(q, speechFinish('a.mp3'), true);
    expect(Array.from(toolCreditModels)).toEqual(['tts-1']);

    // A sound effect has no model id of its own; the same qualified label the usage
    // event carries is what the ledger row would name.
    builder.settleAudioCredits(q, sfxFinish('b.mp3'), true);
    expect(Array.from(toolCreditModels).sort()).toEqual(['elevenlabs-sound_effect', 'tts-1']);
  });

  it('records no charging model when enforcement is off', () => {
    const { builder, toolCreditModels } = makeBuilder();
    builder.settleAudioCredits(quest(), speechFinish('a.mp3'), false);
    expect(toolCreditModels.size).toBe(0);
  });
});

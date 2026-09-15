import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { estimateAudioCredits } from '../../audioCost';

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
  } as unknown as ToolBuilderConfig;
  return { builder: new ToolBuilder(deps), toolCreditsMap, record };
};

const quest = () => ({ id: 'q1', sessionId: 's1', creditsUsed: 0, images: [] as string[] }) as never;
const speechFinish = (path: string) =>
  ({ kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000, paths: [path] }) as const;
const sfxFinish = (path: string) =>
  ({ kind: 'sound_effect', provider: 'elevenlabs', durationSeconds: 5, paths: [path] }) as const;

describe('ToolBuilder audio credit branches', () => {
  it('settle reserves exactly one charge per delivered clip and rides the path on quest.images', () => {
    const { builder, toolCreditsMap, record } = makeBuilder();
    const q = quest();
    builder.settleAudioCredits(q, speechFinish('a.mp3'), true);
    expect(toolCreditsMap.get('audio_generation')).toEqual([speechCost]);
    expect(q.creditsUsed).toBe(speechCost);
    expect(q.images).toEqual(['a.mp3']);
    expect(record).toHaveBeenCalledTimes(1);
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

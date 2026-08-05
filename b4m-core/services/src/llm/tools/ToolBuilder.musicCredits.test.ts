import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { estimateMusicCredits } from '../../musicCost';

// Drives the real music_generation credit branches (gateMusicCredits / settleMusicCredits)
// that ToolBuilder's onToolStart/onToolFinish delegate to, against a fake toolCreditsMap
// and quest - covering the reserve-on-success and enforceCredits paths end to end.

const SHORT = 10_000;
const LONG = 120_000;
const shortCost = estimateMusicCredits('elevenlabs', { lengthMs: SHORT }).requiredCredits;
const longCost = estimateMusicCredits('elevenlabs', { lengthMs: LONG }).requiredCredits;

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
const finishData = (lengthMs: number, path: string) => ({
  paths: [path],
  provider: 'elevenlabs' as const,
  lengthMs,
  modelId: 'eleven_music_v1',
});

describe('ToolBuilder music credit branches', () => {
  it('settle reserves exactly one charge per delivered call and rides the path on quest.images', () => {
    const { builder, toolCreditsMap, record } = makeBuilder();
    const q = quest();
    builder.settleMusicCredits(q, finishData(SHORT, 'a.mp3'), true);
    expect(toolCreditsMap.get('music_generation')).toEqual([shortCost]);
    expect(q.creditsUsed).toBe(shortCost);
    expect(q.images).toEqual(['a.mp3']);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('settle reserves each call independently so two calls sum, not double the later cost', () => {
    const { builder, toolCreditsMap } = makeBuilder();
    const q = quest();
    builder.settleMusicCredits(q, finishData(SHORT, 'a.mp3'), true);
    builder.settleMusicCredits(q, finishData(LONG, 'b.mp3'), true);
    expect(toolCreditsMap.get('music_generation')).toEqual([shortCost, longCost]);
    expect(shortCost).not.toBe(longCost);
    expect(q.creditsUsed).toBe(shortCost + longCost);
  });

  it('settle skips the reservation and usage event when enforceCredits is off, but still delivers the track', () => {
    const { builder, toolCreditsMap, record } = makeBuilder();
    const q = quest();
    builder.settleMusicCredits(q, finishData(SHORT, 'a.mp3'), false);
    expect(toolCreditsMap.has('music_generation')).toBe(false);
    expect(q.creditsUsed).toBe(0);
    expect(record).not.toHaveBeenCalled();
    expect(q.images).toEqual(['a.mp3']);
  });

  it('settle reserves nothing when the credit store is unavailable', () => {
    const { builder, toolCreditsMap } = makeBuilder({ hasCreditStore: false });
    const q = quest();
    builder.settleMusicCredits(q, finishData(SHORT, 'a.mp3'), true);
    expect(toolCreditsMap.has('music_generation')).toBe(false);
    expect(q.images).toEqual(['a.mp3']);
  });

  it('gate throws insufficient_credits before generation when the owner cannot cover the charge', () => {
    const { builder, toolCreditsMap } = makeBuilder({ credits: 0 });
    expect(() => builder.gateMusicCredits({ provider: 'elevenlabs', lengthMs: LONG }, true)).toThrow();
    // The gate never reserves - only settle (reached on success) does.
    expect(toolCreditsMap.has('music_generation')).toBe(false);
  });

  it('gate is a no-op when enforceCredits is off, even with zero balance', () => {
    const { builder } = makeBuilder({ credits: 0 });
    expect(() => builder.gateMusicCredits({ provider: 'elevenlabs', lengthMs: LONG }, false)).not.toThrow();
  });

  it('gate does not throw when the owner can afford the charge', () => {
    const { builder, toolCreditsMap } = makeBuilder({ credits: 1_000_000 });
    expect(() => builder.gateMusicCredits({ provider: 'elevenlabs', lengthMs: SHORT }, true)).not.toThrow();
    expect(toolCreditsMap.has('music_generation')).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { validateUserCredits } from './base/utils';
import { estimateMusicCredits } from '../../musicCost';

// Stub the image cost calculator so the image-reservation tests exercise the reservation
// wiring (one push per call, guard conditions) without an image-pricing fixture. The real
// validateMusicCredits is preserved so the music gate tests still hit the true validator.
vi.mock('./base/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('./base/utils')>();
  return { ...actual, validateUserCredits: vi.fn() };
});
const mockValidateUserCredits = vi.mocked(validateUserCredits);

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

// image_generation/edit_image feed the same per-name queue the music fix introduced, so
// these guard that two image calls in a turn reserve independently (sum, not double) and
// that the guard conditions still short-circuit.
describe('ToolBuilder image credit reservation', () => {
  const MODELS = [{ id: 'gpt-image-1', backend: 'openai' } as ModelInfo];
  const quest = () => ({ id: 'q1', sessionId: 's1', creditsUsed: 0, images: [] as string[] }) as never;
  const saveQuest = vi.fn().mockResolvedValue(null);

  beforeEach(() => {
    mockValidateUserCredits.mockReset();
    saveQuest.mockClear();
  });

  it('reserves one queue entry per call so two image calls sum instead of doubling', async () => {
    mockValidateUserCredits
      .mockResolvedValueOnce({ requiredCredits: 400, usdCost: 0.08 })
      .mockResolvedValueOnce({ requiredCredits: 900, usdCost: 0.18 });
    const { builder, toolCreditsMap } = makeBuilder();
    const q = quest();
    const data = { model: 'gpt-image-1', n: 1 };
    await builder.reserveImageCredits('image_generation', data, true, null, q, saveQuest, MODELS);
    await builder.reserveImageCredits('image_generation', data, true, null, q, saveQuest, MODELS);
    expect(toolCreditsMap.get('image_generation')).toEqual([400, 900]);
    expect(q.creditsUsed).toBe(1300);
  });

  it('reserves nothing when enforceCredits is off', async () => {
    const { builder, toolCreditsMap } = makeBuilder();
    await builder.reserveImageCredits(
      'image_generation',
      { model: 'gpt-image-1' },
      false,
      null,
      quest(),
      saveQuest,
      MODELS
    );
    expect(toolCreditsMap.has('image_generation')).toBe(false);
    expect(mockValidateUserCredits).not.toHaveBeenCalled();
  });

  it('reserves nothing when the model is unknown or absent', async () => {
    const { builder, toolCreditsMap } = makeBuilder();
    await builder.reserveImageCredits(
      'image_generation',
      { model: 'no-such-model' },
      true,
      null,
      quest(),
      saveQuest,
      MODELS
    );
    await builder.reserveImageCredits('image_generation', {}, true, null, quest(), saveQuest, MODELS);
    expect(toolCreditsMap.has('image_generation')).toBe(false);
    expect(mockValidateUserCredits).not.toHaveBeenCalled();
  });

  it('reserves nothing when the credit store is unavailable', async () => {
    const { builder, toolCreditsMap } = makeBuilder({ hasCreditStore: false });
    await builder.reserveImageCredits(
      'image_generation',
      { model: 'gpt-image-1' },
      true,
      null,
      quest(),
      saveQuest,
      MODELS
    );
    expect(toolCreditsMap.has('image_generation')).toBe(false);
  });
});

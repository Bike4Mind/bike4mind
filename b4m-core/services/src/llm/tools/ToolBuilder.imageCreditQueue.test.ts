import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CREDITS_PER_USD_COST, type ModelInfo } from '@bike4mind/common';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { validateUserCredits } from './base/utils';
import { estimateImageCredits } from '../../imageCost';
import { settleToolCallCredits } from '../settleToolCredits';

// The real stochastic rounding, with its draw pinned so the reserved charge is assertable.
const { settlementDraw } = vi.hoisted(() => ({ settlementDraw: vi.fn(() => 0.5) }));
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return {
    ...actual,
    usdToCreditsStochastic: (usd: number) => actual.usdToCreditsStochastic(usd, () => settlementDraw()),
  };
});

// Stub the image cost calculator so these tests exercise the gate/settle wiring (one queue entry
// per delivered call, guard conditions) without an image-pricing fixture.
vi.mock('./base/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('./base/utils')>();
  return { ...actual, validateUserCredits: vi.fn() };
});
vi.mock('../../imageCost', () => ({ estimateImageCredits: vi.fn() }));
const mockValidateUserCredits = vi.mocked(validateUserCredits);
const mockEstimateImageCredits = vi.mocked(estimateImageCredits);

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

const MODELS = [{ id: 'gpt-image-1', backend: 'openai' } as ModelInfo];
const COST_INPUT = { model: 'gpt-image-1', n: 1 };
type TestQuest = { id: string; sessionId: string; creditsUsed: number; images: string[] };
const quest = (): TestQuest => ({ id: 'q1', sessionId: 's1', creditsUsed: 0, images: [] });
const asQuest = (q: TestQuest) => q as never;

// The estimate's USD must agree with its credits: the charge is drawn on the USD.
const usdFor = (credits: number) => credits / CREDITS_PER_USD_COST;

beforeEach(() => {
  settlementDraw.mockReturnValue(0.5);
  mockValidateUserCredits.mockReset().mockResolvedValue({ requiredCredits: 400, usdCost: usdFor(400) });
  mockEstimateImageCredits.mockReset().mockReturnValue({ requiredCredits: 400, usdCost: usdFor(400) } as never);
});

describe('ToolBuilder.gateImageCredits', () => {
  it('checks affordability without reserving anything', async () => {
    const { builder, toolCreditsMap, record } = makeBuilder();

    await builder.gateImageCredits('image_generation', COST_INPUT, true, null, MODELS);

    expect(mockValidateUserCredits).toHaveBeenCalledTimes(1);
    expect(toolCreditsMap.size).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it('propagates insufficient credits so the provider is never called', async () => {
    mockValidateUserCredits.mockRejectedValueOnce(new Error('insufficient_credits'));
    const { builder } = makeBuilder();

    await expect(builder.gateImageCredits('edit_image', COST_INPUT, true, null, MODELS)).rejects.toThrow(
      'insufficient_credits'
    );
  });

  it.each([
    ['enforcement is off', { enforce: false, data: COST_INPUT, hasCreditStore: true }],
    ['the model is unknown', { enforce: true, data: { model: 'no-such-model' }, hasCreditStore: true }],
    ['the model is absent', { enforce: true, data: {}, hasCreditStore: true }],
    ['the credit store is unavailable', { enforce: true, data: COST_INPUT, hasCreditStore: false }],
  ])('is a no-op when %s', async (_label, { enforce, data, hasCreditStore }) => {
    const { builder } = makeBuilder({ hasCreditStore });

    await builder.gateImageCredits('image_generation', data, enforce, null, MODELS);

    expect(mockValidateUserCredits).not.toHaveBeenCalled();
  });
});

describe('ToolBuilder.settleImageCredits', () => {
  it('reserves one queue entry per delivered call so two image calls sum instead of doubling', () => {
    mockEstimateImageCredits
      .mockReturnValueOnce({ requiredCredits: 400, usdCost: usdFor(400) } as never)
      .mockReturnValueOnce({ requiredCredits: 900, usdCost: usdFor(900) } as never);
    const { builder, toolCreditsMap } = makeBuilder();
    const q = quest();

    builder.settleImageCredits('image_generation', asQuest(q), { ...COST_INPUT, paths: ['a.png'] }, true, null, MODELS);
    builder.settleImageCredits('image_generation', asQuest(q), { ...COST_INPUT, paths: ['b.png'] }, true, null, MODELS);

    expect(toolCreditsMap.get('image_generation')).toEqual([400, 900]);
    expect(q.creditsUsed).toBe(1300);
    expect(q.images).toEqual(['a.png', 'b.png']);
  });

  it.each([
    [0.25, 41],
    [0.75, 40],
  ])('charges N or N+1 for a cost of N + 0.5 credits (draw %s -> %s)', (draw, expected) => {
    settlementDraw.mockReturnValue(draw);
    mockEstimateImageCredits.mockReturnValueOnce({ requiredCredits: 41, usdCost: usdFor(40.5) } as never);
    const { builder, toolCreditsMap, toolCreditModels, record } = makeBuilder();
    const q = quest();

    builder.settleImageCredits('image_generation', asQuest(q), { ...COST_INPUT, paths: ['a.png'] }, true, null, MODELS);

    expect(toolCreditsMap.get('image_generation')).toEqual([expected]);
    expect(q.creditsUsed).toBe(expected);
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: expected });
    expect(Array.from(toolCreditModels)).toEqual(['gpt-image-1']);
  });

  it('can charge 0 for a tiny cost: the usage event is still written, but no model is recorded as charging', () => {
    mockEstimateImageCredits.mockReturnValueOnce({ requiredCredits: 1, usdCost: 0.00001 } as never);
    const { builder, toolCreditsMap, toolCreditModels, record } = makeBuilder();
    const q = quest();

    builder.settleImageCredits('image_generation', asQuest(q), { ...COST_INPUT, paths: ['a.png'] }, true, null, MODELS);

    expect(toolCreditsMap.get('image_generation')).toEqual([0]);
    expect(q.creditsUsed).toBe(0);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0, costUsd: 0.00001 });
    expect(toolCreditModels.size).toBe(0);
    expect(q.images).toEqual(['a.png']);
  });

  it.each([
    ['enforcement is off', { enforce: false, data: COST_INPUT, hasCreditStore: true }],
    ['the model is unknown', { enforce: true, data: { model: 'no-such-model' }, hasCreditStore: true }],
    ['the credit store is unavailable', { enforce: true, data: COST_INPUT, hasCreditStore: false }],
  ])('bills nothing but still attaches the image when %s', (_label, { enforce, data, hasCreditStore }) => {
    const { builder, toolCreditsMap, record } = makeBuilder({ hasCreditStore });
    const q = quest();

    builder.settleImageCredits('image_generation', asQuest(q), { ...data, paths: ['a.png'] }, enforce, null, MODELS);

    expect(toolCreditsMap.has('image_generation')).toBe(false);
    expect(q.creditsUsed).toBe(0);
    expect(record).not.toHaveBeenCalled();
    expect(q.images).toEqual(['a.png']);
  });
});

// The provider-rejected-key scenario: the model calls image_generation, the provider errors (the
// tool returns before onFinish), and the model retries successfully. Only the retry is billed.
describe('a failed image call followed by a successful retry', () => {
  it('bills only the delivered call, on the quest and at turn settlement', async () => {
    const { builder, toolCreditsMap, record } = makeBuilder();
    const q = quest();

    // Attempt 1: gate passes, provider fails, onFinish never fires.
    await builder.gateImageCredits('image_generation', COST_INPUT, true, null, MODELS);
    // Attempt 2: gate passes, image delivered.
    await builder.gateImageCredits('image_generation', COST_INPUT, true, null, MODELS);
    builder.settleImageCredits('image_generation', asQuest(q), { ...COST_INPUT, paths: ['a.png'] }, true, null, MODELS);

    expect(q.creditsUsed).toBe(400);
    expect(record).toHaveBeenCalledTimes(1);

    const settled = settleToolCallCredits(
      [{ name: 'image_generation' }, { name: 'image_generation' }, { name: 'web_search' }],
      toolCreditsMap
    );
    const billed = settled.reduce((sum, call) => sum + (call.creditsUsed ?? 0), 0);
    expect(billed).toBe(400);
  });
});

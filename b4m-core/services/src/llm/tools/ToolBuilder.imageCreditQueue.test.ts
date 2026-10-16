import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { validateUserCredits } from './base/utils';
import { estimateImageCredits } from '../../imageCost';
import { settleToolCallCredits } from '../settleToolCredits';

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

beforeEach(() => {
  mockValidateUserCredits.mockReset().mockResolvedValue({ requiredCredits: 400, usdCost: 0.08 });
  mockEstimateImageCredits.mockReset().mockReturnValue({ requiredCredits: 400, usdCost: 0.08 } as never);
});

describe('ToolBuilder.gateImageCredits', () => {
  it('passes the credits already committed this turn, gated or settled, to the affordability check', async () => {
    const { builder } = makeBuilder();

    await builder.gateImageCredits('image_generation', COST_INPUT, true, null, MODELS);
    await builder.gateImageCredits('image_generation', COST_INPUT, true, null, MODELS);
    builder.settleImageCredits(
      'image_generation',
      asQuest(quest()),
      { ...COST_INPUT, paths: ['a.png'] } as never,
      true,
      null,
      MODELS
    );
    await builder.gateImageCredits('edit_image', COST_INPUT, true, null, MODELS);

    // In flight: 0, then 400. After one settles, its gate entry is replaced by the 400 charge.
    expect(mockValidateUserCredits.mock.calls.map(call => call[6])).toEqual([0, 400, 800]);
  });

  it('drops the estimate of a call that fails before settling, so a retry is not refused', async () => {
    const { builder } = makeBuilder();
    type Tracked = { toolFn: (val: unknown) => Promise<unknown> };
    const [tool] = (builder as unknown as { trackGatedCalls(tools: unknown[]): Tracked[] }).trackGatedCalls([
      {
        toolSchema: { name: 'image_generation' },
        toolFn: async () => {
          await builder.gateImageCredits('image_generation', COST_INPUT, true, null, MODELS);
          throw new Error('content policy');
        },
      },
    ]);

    await expect(tool.toolFn({})).rejects.toThrow('content policy');
    await builder.gateImageCredits('image_generation', COST_INPUT, true, null, MODELS);

    expect(mockValidateUserCredits.mock.calls.map(call => call[6])).toEqual([0, 0]);
  });

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
      .mockReturnValueOnce({ requiredCredits: 400, usdCost: 0.08 } as never)
      .mockReturnValueOnce({ requiredCredits: 900, usdCost: 0.18 } as never);
    const { builder, toolCreditsMap } = makeBuilder();
    const q = quest();

    builder.settleImageCredits('image_generation', asQuest(q), { ...COST_INPUT, paths: ['a.png'] }, true, null, MODELS);
    builder.settleImageCredits('image_generation', asQuest(q), { ...COST_INPUT, paths: ['b.png'] }, true, null, MODELS);

    expect(toolCreditsMap.get('image_generation')).toEqual([400, 900]);
    expect(q.creditsUsed).toBe(1300);
    expect(q.images).toEqual(['a.png', 'b.png']);
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

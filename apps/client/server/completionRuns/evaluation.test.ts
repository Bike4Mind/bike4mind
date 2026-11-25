import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo, type CompletionEvaluationState } from '@bike4mind/common';
import { evaluationTransport, initialEvaluation, assertEvaluationAuthorized } from './evaluation';

const db = vi.hoisted(() => ({
  state: undefined as unknown as CompletionEvaluationState,
  queue: Promise.resolve(),
  settings: {} as Record<string, string>,
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: async (name: string) => db.settings[name] },
  completionRunRepository: {
    updateEvaluation: (_id: string, change: (state: CompletionEvaluationState) => CompletionEvaluationState) => {
      const result = db.queue.then(() => {
        const next = change(structuredClone(db.state));
        next.revision++;
        db.state = next;
        return next;
      });
      db.queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  },
}));
const model = {
  id: 'gpt-test-2026-01-01',
  backend: ModelBackend.OpenAI,
  contextWindow: 1000,
  pricing: { 2000: { input: 0.000001, output: 0.000002, cache_read: 0.0000001 } },
} as ModelInfo;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
beforeEach(() => {
  db.settings = { evaluationModelIds: `${model.id},alias` };
  db.queue = Promise.resolve();
  db.state = initialEvaluation({
    version: 1,
    maxProviderUsd: 1,
    maxTokens: 5000,
    maxRequests: 3,
    modelIds: [model.id],
  });
});

describe('evaluation provider reservations', () => {
  it('serializes concurrent admission and preserves the losing budget', async () => {
    const outcomes = await Promise.allSettled(
      [1, 2].map(n => evaluationTransport('run', id(n)).admit(model, model.id, 100))
    );
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(db.state.committedRequests).toBe(1);
    expect(db.state.committedTokens).toBe(1100);
  });
  it('retains unknown disconnect holds and blocks a restart from dispatching again', async () => {
    const first = evaluationTransport('run', id(1));
    await first.admit(model, model.id, 100);
    const held = db.state.committedProviderUsd;
    await first.unknown();
    expect(db.state.receipts[0].status).toBe('unknown');
    await expect(evaluationTransport('run', id(1)).admit(model, model.id, 100)).rejects.toMatchObject({
      message: expect.stringContaining('already exists'),
      additionalInfo: { errorCode: 'evaluation_request_exists' },
    });
    await expect(evaluationTransport('run', id(2)).admit(model, model.id, 100)).rejects.toMatchObject({
      message: expect.stringContaining('outstanding'),
      additionalInfo: { errorCode: 'evaluation_receipt_outstanding' },
    });
    expect(db.state.committedProviderUsd).toBe(held);
  });
  it('reconciles authoritative cached/reasoning usage once using captured rates', async () => {
    const first = evaluationTransport('run', id(1));
    await first.admit(model, model.id, 100);
    const usage = { inputTokens: 100, outputTokens: 30, cacheReadTokens: 50, reasoningTokens: 20 };
    await first.reconcile(usage);
    await first.reconcile(usage);
    expect(db.state.committedProviderUsd).toBeCloseTo(0.000115);
    expect(db.state.committedTokens).toBe(130);
    expect(db.state.receipts[0]).toMatchObject({ status: 'complete', ...usage });
    await first.platform({ usdCost: 4, creditsCharged: 20 });
    expect(db.state.committedProviderUsd).toBeCloseTo(0.000115);
    expect(db.state.receipts[0].platformUsd).toBe(4);
  });
  it('fails closed for budget, missing rates and substituted models', async () => {
    db.state.limits.maxTokens = 100;
    await expect(evaluationTransport('run', id(1)).admit(model, model.id, 100)).rejects.toMatchObject({
      message: expect.stringContaining('budget'),
      additionalInfo: { errorCode: 'evaluation_budget_exhausted' },
    });
    await expect(evaluationTransport('run', id(2)).admit({ ...model, pricing: {} }, model.id, 100)).rejects.toThrow(
      'unpriced'
    );
    await expect(evaluationTransport('run', id(3)).admit(model, 'alias', 100)).rejects.toThrow('Unsupported');
    expect(db.state.committedRequests).toBe(0);
  });
  it('recovers pre-dispatch rejection without a hold or repeat dispatch', async () => {
    await evaluationTransport('run', id(1)).rejected(model.id);
    expect(db.state.receipts[0].status).toBe('rejected-before-dispatch');
    await expect(evaluationTransport('run', id(1)).admit(model, model.id, 100)).rejects.toThrow('already exists');
    expect(db.state.committedProviderUsd).toBe(0);
  });
  it('requires an admin-granted account, read on every call', async () => {
    const refused = expect.objectContaining({
      message: expect.stringContaining('not enabled'),
      additionalInfo: { errorCode: 'evaluation_not_enabled' },
    });
    await expect(assertEvaluationAuthorized('allowed')).rejects.toThrow(refused);
    db.settings.evaluationUserIds = ' other , allowed ,';
    await expect(assertEvaluationAuthorized('other')).resolves.toBeUndefined();
    await expect(assertEvaluationAuthorized('allowed')).resolves.toBeUndefined();
    await expect(assertEvaluationAuthorized('')).rejects.toThrow(refused);
  });
  it('refuses dispatch to a model removed from the evaluationModelIds setting', async () => {
    db.settings.evaluationModelIds = 'alias';
    await expect(evaluationTransport('run', id(1)).admit(model, model.id, 100)).rejects.toThrow(
      'not enabled in the evaluationModelIds admin setting'
    );
    expect(db.state.receipts).toEqual([]);
  });
  it('retains all reservations for invalid authoritative usage and preserves pricing across catalog changes', async () => {
    const first = evaluationTransport('run', id(1));
    const mutableModel = structuredClone(model);
    await first.admit(mutableModel, model.id, 100);
    mutableModel.pricing[2000].input = 1000;
    const hold = db.state.committedProviderUsd;
    await expect(first.reconcile({ inputTokens: 10, outputTokens: 101, cacheReadTokens: 0 })).rejects.toThrow('bounds');
    expect(db.state.committedProviderUsd).toBe(hold);
    await first.reconcile({ inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 });
    expect(db.state.committedProviderUsd).toBeCloseTo(0.00003);
  });
  it('prices both Anthropic cache TTLs and reads on the total prompt tier using captured rates', async () => {
    const opus = { ...model, backend: ModelBackend.Anthropic };
    const first = evaluationTransport('run', id(1));
    await first.admit(opus, opus.id, 100);
    expect(db.state.committedProviderUsd).toBeCloseTo(0.0022);
    const usage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 20,
      cacheWrite5mTokens: 30,
      cacheWrite1hTokens: 40,
    };
    await first.reconcile(usage);
    await first.reconcile(usage);
    expect(db.state.committedProviderUsd).toBeCloseTo(0.0001495);
    expect(db.state.receipts[0]).toMatchObject({ ...usage, tierBasisTokens: 100, status: 'complete' });
    expect(db.state.receipts[0].rates[0].cacheWrite5m).toBeCloseTo(0.00000125, 12);
    expect(db.state.receipts[0].rates[0].cacheWrite1h).toBe(0.000002);
  });
  it('retains Anthropic holds when a cache usage class is absent', async () => {
    const first = evaluationTransport('run', id(1));
    await first.admit({ ...model, backend: ModelBackend.Anthropic }, model.id, 100);
    const held = db.state.committedProviderUsd;
    await expect(first.reconcile({ inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 })).rejects.toThrow(
      'cache write'
    );
    await first.unknown();
    expect(db.state.committedProviderUsd).toBe(held);
    expect(db.state.receipts[0].status).toBe('unknown');
  });
});

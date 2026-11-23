import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AxiosInstance } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth/AuthService';
import type { ChatModelOption } from '@shared/chat';
import { EVALUATION_LIMITS, EvaluationBudget, assertEvaluationTool, evaluationContext } from './evaluationBudget';
import { runLiveEvaluation } from './liveEvaluation';
import { bindEvaluationModel, streamCompletion } from './completions';

const model: ChatModelOption = {
  id: 'gpt-6.1-sol',
  name: 'Pinned fixture',
  backend: 'openai',
  pricing: { 200_000: { input: 0.000001, output: 0.000004 } },
};
const request = () => ({ model: model.id, messages: [{ role: 'user' as const, content: 'Fixture' }] });
const roots: string[] = [];
const budgets: EvaluationBudget[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'evaluation-gate-'));
  roots.push(root);
  const path = join(root, 'budget.sqlite');
  const budget = new EvaluationBudget(path);
  budgets.push(budget);
  return { root, path, budget };
}
afterEach(async () => {
  for (const budget of budgets.splice(0)) budget.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('durable evaluation admission', () => {
  it('reserves before transport, clamps output and rejects concurrent requests', async () => {
    const { budget } = await setup();
    const body = { ...request(), maxTokens: 9000 };
    const release = budget.reserve('first', body, model);
    expect(body.maxTokens).toBe(EVALUATION_LIMITS.outputTokens);
    expect(budget.report()).toMatchObject([{ status: 'unknown', reservedUsd: 0.270336 }]);
    expect(() => budget.reserve('second', request(), model)).toThrow('concurrency');
    release();
  });

  it('retains unknown holds across separate ledger connections and restart', async () => {
    const { budget, path } = await setup();
    budget.reserve('first', request(), model)();
    const restarted = new EvaluationBudget(path);
    budgets.push(restarted);
    expect(() => restarted.reserve('retry', request(), model)).toThrow('unresolved');
    expect(restarted.report()).toEqual(budget.report());
  });

  it('keeps an active ledger writable through teardown without admitting more requests', async () => {
    const { budget, path } = await setup();
    const release = budget.reserve('first', request(), model);
    budget.close();
    expect(() => budget.reserve('second', request(), model)).toThrow('closing');
    budget.record('first', [], true);
    release();
    const reopened = new EvaluationBudget(path);
    budgets.push(reopened);
    expect(reopened.report()).toMatchObject([{ status: 'failed-unknown-charge' }]);
  });

  it('folds request usage by replacement and keeps provider pricing distinct from settlement', async () => {
    const { budget } = await setup();
    budget.reserve('first', request(), model)();
    budget.record(
      'first',
      [
        { type: 'meta', requestId: 'first' },
        { type: 'content', usage: { inputTokens: 100, outputTokens: 1 } },
        { type: 'content', usage: { outputTokens: 4 } },
        { type: 'settled', requestId: 'first', usdCost: 0.01, creditsCharged: 2 },
      ],
      false
    );
    expect(budget.report()).toMatchObject([
      {
        status: 'usage-reported-charge-unverified',
        providerPricedUsd: null,
        platformUsd: 0.01,
        usage: JSON.stringify({ inputTokens: 100, outputTokens: 4 }),
      },
    ]);
    expect(() => budget.reserve('second', request(), model)).toThrow('unresolved');
  });

  it('keeps failed or mismatched charges unknown without storing error text', async () => {
    const { budget } = await setup();
    budget.reserve('first', request(), model)();
    budget.record('first', [{ type: 'settled', requestId: 'wrong', usdCost: 9, creditsCharged: 3 }], true);
    expect(budget.report()).toMatchObject([
      { status: 'failed-unknown-charge', platformUsd: null, platformCredits: null },
    ]);
  });

  it('refuses unknown pricing, expensive reservations, excessive input and other models', async () => {
    const { budget } = await setup();
    expect(() => budget.reserve('a', { ...request(), maxTokens: NaN }, model)).toThrow('output bound');
    expect(() => budget.reserve('a', request(), { ...model, pricing: undefined })).toThrow('pricing');
    expect(() => budget.reserve('a', request(), { ...model, pricing: { 1: { input: NaN, output: 1 } } })).toThrow(
      'pricing'
    );
    expect(() => budget.reserve('a', request(), { ...model, pricing: { 1: { input: 1, output: 1 } } })).toThrow(
      'exhausted'
    );
    expect(() =>
      budget.reserve('a', { ...request(), messages: [{ role: 'user', content: 'x'.repeat(100_000) }] }, model)
    ).toThrow('input');
    expect(() => budget.reserve('a', { ...request(), model: 'opus' }, model)).toThrow('pinned');
    expect(budget.report()).toEqual([]);
  });

  it('gates the real completion transport before POST and retains a disconnected attempt', async () => {
    const { budget } = await setup();
    const stream = new PassThrough();
    const post = vi.fn().mockResolvedValue({ data: stream, status: 200 });
    const axios = { post } as unknown as AxiosInstance;
    bindEvaluationModel(axios, model);
    await evaluationContext.run(budget, async () => {
      const done = streamCompletion(axios, '/api/ai/v1/completions', request(), () => {});
      await vi.waitUntil(() => post.mock.calls.length === 1);
      expect(post.mock.calls[0][1].max_tokens).toBe(EVALUATION_LIMITS.outputTokens);
      expect(budget.report()).toMatchObject([{ status: 'unknown' }]);
      stream.end();
      await done;
      await expect(streamCompletion(axios, '/api/ai/v1/completions', request(), () => {})).rejects.toThrow(
        'unresolved'
      );
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  it('denies workers and paid tools only inside the evaluator context', async () => {
    const { budget } = await setup();
    expect(() => assertEvaluationTool('session_spawn')).not.toThrow();
    evaluationContext.run(budget, () => {
      expect(() => assertEvaluationTool('session_spawn')).toThrow('not permitted');
      expect(() => assertEvaluationTool('generate_image')).toThrow('not permitted');
      expect(() => assertEvaluationTool('file_read')).not.toThrow();
    });
  });

  it('does nothing without opt-in and writes a blocked report without touching auth even with opt-in', async () => {
    const { root } = await setup();
    const getSessionBoundApiClient = vi.fn(() => {
      throw new Error('Must not read auth');
    });
    const auth = { getSessionBoundApiClient } as unknown as AuthService;
    await runLiveEvaluation(auth, root, false);
    await expect(readFile(join(root, 'blocked.json'))).rejects.toThrow();
    await runLiveEvaluation(auth, root, true);
    const report = JSON.parse(await readFile(join(root, 'blocked.json'), 'utf8'));
    expect(report.status).toBe('blocked');
    expect(report.blockers).toContain('issuer-authorization-amendment-pending');
    expect(report.blockers).toContain('backend-billed-token-and-retry-bound-unverified');
    expect(report.attempts).toEqual([]);
    expect(getSessionBoundApiClient).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(root);
  });
});

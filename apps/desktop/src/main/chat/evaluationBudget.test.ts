import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { AxiosInstance } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth/AuthService';
import type { ChatModelOption } from '@shared/chat';
import { ChatModels } from '@bike4mind/common';
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
const runId = randomUUID();
const limits = {
  version: 1,
  maxProviderUsd: 150,
  maxTokens: EVALUATION_LIMITS.totalTokens,
  maxRequests: EVALUATION_LIMITS.requests,
  modelIds: [model.id],
};
const snapshot = (receipts: unknown[] = []) => ({
  version: 1,
  limits,
  revision: 1,
  committedProviderUsd: 0,
  committedTokens: 0,
  committedRequests: receipts.length,
  receipts,
});
const receipt = (requestId: string, revision = 2) => ({
  version: 1,
  requestId,
  attemptId: requestId,
  revision,
  status: 'complete',
  modelId: model.id,
  backend: 'openai',
  pricingRevision: 'fixed-test-rates',
  maxProviderUsd: 0.270336,
  maxTokens: 1000,
  providerUsd: 0.001,
  inputTokens: 100,
  outputTokens: 4,
  maxInputTokens: 900,
  maxOutputTokens: 100,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 50,
  reasoningTokens: 1,
  provenance: 'provider-reported-usage/catalog-rates',
  rates: [{ tier: 200_000, input: 0.000001, output: 0.000004, cacheRead: 0.000001 }],
});
const remote = () => ({
  post: vi.fn().mockResolvedValue({ data: { runId, evaluation: snapshot(), createdAt: new Date().toISOString() } }),
  get: vi.fn().mockResolvedValue({ data: snapshot() }),
});
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
      budget.reserve('a', { ...request(), messages: [{ role: 'user', content: 'x'.repeat(200_000) }] }, model)
    ).toThrow('input');
    expect(() => budget.reserve('a', { ...request(), model: 'opus' }, model)).toThrow('pinned');
    expect(budget.report()).toEqual([]);
  });

  it('gates the real completion transport before POST and retains a disconnected attempt', async () => {
    const { budget } = await setup();
    const stream = new PassThrough();
    const post = vi.fn().mockResolvedValue({ data: stream, status: 200 });
    const server = remote();
    const axios = { ...server, post } as unknown as AxiosInstance;
    await budget.connect(server as unknown as AxiosInstance, [model.id]);
    bindEvaluationModel(axios, model);
    await evaluationContext.run(budget, async () => {
      const done = streamCompletion(axios, '/api/ai/v1/completions', request(), () => {});
      await vi.waitUntil(() => post.mock.calls.length === 1);
      expect(post.mock.calls[0][1].max_tokens).toBe(EVALUATION_LIMITS.outputTokens);
      expect(post.mock.calls[0][1].evaluation).toMatchObject({ version: 1 });
      expect(post.mock.calls[0][1].run).toEqual({ runId, role: 'root', purpose: 'turn' });
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
      expect(() => assertEvaluationTool('session_spawn')).toThrow('worker limit');
      expect(() => assertEvaluationTool('generate_image')).toThrow('not permitted');
      expect(() => assertEvaluationTool('file_read')).not.toThrow();
    });
  });

  it('does nothing without opt-in and records missing signed-in authorization without paid dispatch', async () => {
    const { root } = await setup();
    const getSessionBoundApiClient = vi.fn(() => null);
    const auth = { getSessionBoundApiClient } as unknown as AuthService;
    await runLiveEvaluation(auth, root, false);
    await expect(readFile(join(root, 'report.json'))).rejects.toThrow();
    expect(getSessionBoundApiClient).not.toHaveBeenCalled();
    await runLiveEvaluation(auth, root, true);
    const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
    expect(report.status).toBe('stopped-recovery-or-authorization-required');
    expect(report.attempts).toEqual([]);
    expect(getSessionBoundApiClient).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it('releases only authoritative receipts and recovers the same server run after restart', async () => {
    const { budget, path } = await setup();
    const server = remote();
    await budget.connect(server as unknown as AxiosInstance, [model.id]);
    const id = randomUUID();
    budget.reserve(id, request(), model)();
    budget.record(id, [{ type: 'settled', requestId: id, usdCost: 4, creditsCharged: 7 }], false);
    expect(() => budget.reserve(randomUUID(), request(), model)).toThrow('unresolved');
    server.get.mockResolvedValue({ data: snapshot([receipt(id)]) });
    await budget.reconcile();
    await budget.reconcile();
    expect(budget.totals()).toMatchObject({
      attemptCount: 1,
      unresolvedAttempts: 0,
      providerPricedUsd: 0.001,
      platformUsd: 4,
    });
    const exported = JSON.stringify(budget.report());
    expect(exported).not.toContain(id);
    expect(exported).toContain('provider-reported-usage/catalog-rates');
    expect(exported).toContain('cacheReadTokens');
    const reopened = new EvaluationBudget(path);
    budgets.push(reopened);
    await reopened.connect(server as unknown as AxiosInstance, [model.id]);
    expect(server.post).toHaveBeenCalledTimes(1);
    expect(reopened.wire(randomUUID()).run.runId).toBe(runId);
    reopened.reserve(randomUUID(), request(), model)();
  });

  it('retains unknown receipts, rejects conflicting revisions and sanitizes measured blocks', async () => {
    const { budget } = await setup();
    const server = remote();
    await budget.connect(server as unknown as AxiosInstance, [model.id]);
    const id = randomUUID();
    budget.reserve(id, request(), model)();
    budget.measure(id, { ...request(), messages: [{ role: 'system', content: '/private/fixture-secret' }] });
    server.get.mockResolvedValue({ data: snapshot([{ ...receipt(id), status: 'unknown', providerUsd: undefined }]) });
    await budget.reconcile();
    expect(() => budget.reserve(randomUUID(), request(), model)).toThrow('unresolved');
    expect(JSON.stringify(budget.report())).not.toContain('fixture-secret');
    expect(JSON.stringify(budget.report())).not.toContain('sha256');
    server.get.mockResolvedValue({ data: snapshot([receipt(id)]) });
    await expect(budget.reconcile()).rejects.toThrow('revision conflict');
  });

  it('releases only a zero-bound not-dispatched rejection and admits the next attempt', async () => {
    const { budget } = await setup();
    const server = remote();
    await budget.connect(server as unknown as AxiosInstance, [model.id]);
    const id = randomUUID();
    budget.reserve(id, request(), model)();
    const rejected = {
      ...receipt(id),
      status: 'rejected-before-dispatch',
      backend: 'not-dispatched',
      pricingRevision: 'not-dispatched',
      maxProviderUsd: 0,
      maxTokens: 0,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      providerUsd: undefined,
      rates: [],
    };
    server.get.mockResolvedValue({ data: snapshot([{ ...rejected, maxTokens: 1 }]) });
    await expect(budget.reconcile()).rejects.toThrow('Invalid evaluation rejection');
    expect(() => budget.reserve(randomUUID(), request(), model)).toThrow('unresolved');
    server.get.mockResolvedValue({ data: snapshot([rejected]) });
    await budget.reconcile();
    expect(budget.totals()).toMatchObject({ unresolvedAttempts: 0, providerPricedUsd: 0 });
    budget.reserve(randomUUID(), request(), model)();
  });

  it('allows retry after administrative refusal and idempotently recovers ambiguous run creation', async () => {
    const { budget } = await setup();
    const server = remote();
    server.post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 403 } });
    await expect(budget.connect(server as unknown as AxiosInstance, [model.id])).rejects.toBeDefined();
    await budget.connect(server as unknown as AxiosInstance, [model.id]);
    expect(server.post).toHaveBeenCalledTimes(2);
    const other = await setup();
    server.post.mockRejectedValueOnce(new Error('connection lost'));
    await expect(other.budget.connect(server as unknown as AxiosInstance, [model.id])).rejects.toThrow(
      'connection lost'
    );
    await other.budget.connect(server as unknown as AxiosInstance, [model.id]);
    expect(server.post).toHaveBeenCalledTimes(4);
    expect(server.post.mock.calls[2][1]).toEqual(server.post.mock.calls[3][1]);
  });

  it('imports a known ownership-checked run without minting and refuses replacing it', async () => {
    const { budget } = await setup();
    const server = remote();
    await budget.connect(server as unknown as AxiosInstance, [model.id], runId);
    expect(server.post).not.toHaveBeenCalled();
    expect(budget.wire(randomUUID()).run.runId).toBe(runId);
    await expect(budget.connect(server as unknown as AxiosInstance, [model.id], randomUUID())).rejects.toThrow(
      'Cannot replace'
    );
  });

  it('fences late auxiliary requests before receipt lookup or dispatch during teardown', async () => {
    const { budget } = await setup();
    const server = remote();
    budget.pauseDispatch();
    await evaluationContext.run(budget, async () => {
      await expect(
        streamCompletion(server as unknown as AxiosInstance, '/api/ai/v1/completions', request(), () => {})
      ).rejects.toThrow('transport is stopped');
    });
    expect(server.get).not.toHaveBeenCalled();
    expect(server.post).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'runs actual ChatService including worker=%s through authoritative receipts',
    async workers => {
      const { root } = await setup();
      const receipts: ReturnType<typeof receipt>[] = [];
      let completions = 0;
      const opus = { ...model, id: ChatModels.CLAUDE_5_5_OPUS, name: 'Opus fixture', backend: 'anthropic' };
      const activeLimits = { ...limits, modelIds: workers ? [model.id] : [model.id, opus.id] };
      const activeSnapshot = () => ({ ...snapshot(receipts), limits: activeLimits });
      const readSessions = new Set<string>();
      const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      const axios = {
        get: vi.fn(async () => ({ data: activeSnapshot() })),
        post: vi.fn(
          async (
            url: string,
            body: {
              model: string;
              evaluation: { requestId: string };
              messages: unknown[];
              sessionId: string;
              run: { runId: string };
            }
          ) => {
            if (url === '/api/v1/completion-runs')
              return { data: { runId, createdAt: new Date().toISOString(), evaluation: activeSnapshot() } };
            completions++;
            expect(body.run.runId).toBe(runId);
            const id = body.evaluation.requestId;
            receipts.push({
              ...receipt(id),
              modelId: body.model,
              backend: body.model === opus.id ? 'anthropic' : 'openai',
            });
            const stream = new PassThrough();
            setTimeout(() => {
              if (!readSessions.has(body.sessionId)) {
                readSessions.add(body.sessionId);
                const text = JSON.stringify(body.messages);
                const directory = text.match(/Working directory[^\n]*?([^\s"\\]+\/project)/i)?.[1];
                if (!directory) {
                  stream.end(frame({ type: 'error', message: 'fixture path missing' }));
                  return;
                }
                stream.write(
                  frame({
                    type: 'tool_use',
                    tools: [
                      {
                        id: 'read-ledger',
                        name: 'file_read',
                        arguments: JSON.stringify({ path: join(directory, 'ledger.json') }),
                      },
                    ],
                  })
                );
              } else stream.write(frame({ type: 'content', text: '21' }));
              stream.end('data: [DONE]\n\n');
            }, 10);
            return { data: stream, status: 200 };
          }
        ),
      };
      const api = {
        getAxiosInstance: () => axios,
        get: async (url: string) =>
          url === '/api/models'
            ? {
                models: [model, opus].map(option => ({
                  ...option,
                  type: 'text',
                  contextWindow: 131072,
                  max_tokens: 2048,
                  supportsTools: true,
                })),
              }
            : {},
      };
      const auth = {
        getSessionBoundApiClient: () => api,
        getState: () => ({ environment: { url: 'https://fixture.invalid' } }),
      } as unknown as AuthService;
      const config = join(root, 'config.json');
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          arms: ['reference'],
          warm: false,
          longLoop: false,
          toolChange: false,
          workers,
          ...(!workers ? { finalModelId: opus.id } : {}),
        })
      );
      await runLiveEvaluation(auth, root, true, config, { workerQuietMs: 50 });
      const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
      expect(report.status).toBe('complete');
      expect(report.accepted, JSON.stringify({ outcomes: report.outcomes, attempts: report.attempts })).toBe(
        workers ? 2 : 1
      );
      expect(report.attempts.length).toBeGreaterThanOrEqual(workers ? 5 : 2);
      expect(report.providerPricedUsd).toBeCloseTo(completions * 0.001);
      expect(report.costPerAcceptedResultUsd).toBeCloseTo((completions * 0.001) / report.accepted);
      expect(JSON.stringify(report)).not.toContain(root);
      expect(JSON.stringify(report)).not.toContain('ledger.json');
      if (!workers) {
        const beforeFinal = completions;
        await runLiveEvaluation(auth, root, true, config);
        expect(completions).toBe(beforeFinal);
        expect(receipts.every(item => item.modelId === model.id)).toBe(true);
        await runLiveEvaluation(auth, root, true, config, { finalPhase: true });
        const finalReport = JSON.parse(await readFile(join(root, 'report-final.json'), 'utf8'));
        expect(finalReport.status).toBe('complete');
        expect(finalReport.accepted, JSON.stringify(finalReport)).toBe(1);
        expect(receipts.at(-1)?.modelId).toBe(opus.id);
        expect(axios.post.mock.calls.filter(call => call[0] === '/api/v1/completion-runs')).toHaveLength(1);
        const checkpointPath = join(root, 'checkpoint.json');
        const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
        checkpoint.outcomes = checkpoint.outcomes.map((outcome: Record<string, unknown>) => ({
          ...outcome,
          accepted: false,
        }));
        await writeFile(checkpointPath, JSON.stringify(checkpoint));
        const beforeRejectedFinal = completions;
        await runLiveEvaluation(auth, root, true, config, { finalPhase: true });
        expect(completions).toBe(beforeRejectedFinal);
        expect(JSON.parse(await readFile(join(root, 'report-final.json'), 'utf8')).status).toBe(
          'stopped-recovery-or-authorization-required'
        );
      }
    }
  );
});

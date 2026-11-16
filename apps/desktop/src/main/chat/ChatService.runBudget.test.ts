import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { CompletionRunAttribution, CompletionRunBudgetState } from '@bike4mind/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_BUDGET_STOP, type ChatModelOption, type ChatStreamEvent } from '@shared/chat';
import type { TaskContract } from '@shared/orchestration';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { CompletionRunMinter } from './completionRuns';
import type { ModelCatalog } from './ModelCatalog';
import type { AccessStore } from './tools/AccessStore';

const RUN_A = '7d0c8f3e-2b1a-4c5d-9e8f-0a1b2c3d4e5f';
const BUDGET_PATH = `/api/v1/completion-runs/${RUN_A}/budget`;
const USAGE_PATH = `/api/v1/completion-runs/${RUN_A}/usage`;
const contract: TaskContract = {
  version: 1,
  outcome: 'Fix the focused behavior',
  rationale: 'Keep scope bounded',
  role: 'implementation',
  paths: ['src/feature.ts'],
  contextReferences: [],
  ownedChanges: ['src/feature.ts'],
  coordinationConstraints: [],
  nonGoals: [],
  acceptanceCriteria: ['Focused test passes'],
  verification: ['pnpm test feature'],
  assumptions: [],
  escalationConditions: ['Public API must change'],
};
const frame = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
type Wire = { model: string; run?: CompletionRunAttribution };

const spend = {
  creditsCharged: 0,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const usage = (budget: CompletionRunBudgetState) => ({
  runId: RUN_A,
  createdAt: '2026-11-10T00:00:00.000Z',
  settled: spend,
  byRole: [],
  byPurpose: [],
  byModel: [],
  byAttempt: [],
  byAttemptTruncated: false,
  budget,
});

/** A rejection shaped like axios's for a streamed request: its body is a stream too. */
const rejection = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    response: { status, data: Readable.from([Buffer.from(JSON.stringify(body))]) },
  });
const exhausted = () => rejection(422, { error: 'Run budget exhausted', errorCode: 'run_budget_exhausted' });

describe('orchestration run budget', () => {
  let store: SessionStore;
  let service: ChatService;
  let project: string;
  let streams: PassThrough[];
  type Request = (...args: unknown[]) => Promise<unknown>;
  let completions: ReturnType<typeof vi.fn<Request>>;
  let raise: ReturnType<typeof vi.fn<Request>>;
  let get: ReturnType<typeof vi.fn<Request>>;
  let mint: ReturnType<typeof vi.fn<CompletionRunMinter>>;
  let events: ChatStreamEvent[];
  let budgetState: CompletionRunBudgetState;

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-budget-project-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-budget-store-')), 'planner');
    const models: ChatModelOption[] = [
      { id: 'planner', name: 'Planner', supportsTools: true },
      { id: 'worker', name: 'Worker', supportsTools: true },
      // A small model for a suggestion request to pick.
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku', supportsTools: true },
    ];
    streams = [];
    events = [];
    budgetState = { budgetCredits: 500, committedCredits: 100, reservedCredits: 0, remainingCredits: 400 };
    completions = vi.fn<Request>().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    raise = vi.fn<Request>().mockResolvedValue({ status: 200, data: {} });
    const post = vi.fn((url: string, ...rest: unknown[]) =>
      url === BUDGET_PATH ? raise(url, ...rest) : completions(url, ...rest)
    );
    get = vi.fn<Request>(url =>
      url === USAGE_PATH ? Promise.resolve({ data: usage(budgetState) }) : Promise.reject(new Error(`no ${url}`))
    );
    mint = vi.fn<CompletionRunMinter>().mockResolvedValue({ runId: RUN_A, createdAt: '2026-11-10T00:00:00.000Z' });
    service = new ChatService({
      store,
      summaryChanged: vi.fn(),
      access: { list: async () => [] } as unknown as AccessStore,
      models: { list: async () => ({ models }), cached: () => models } as unknown as ModelCatalog,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post, get }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => void events.push(event),
      mintCompletionRun: mint,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    for (const stream of streams) stream.end();
  });

  const wire = (index: number) => completions.mock.calls[index][1] as Wire;
  const created = () =>
    store.create('planner', {
      title: 'Fixed test title',
      mode: 'code',
      project: {
        directory: project,
        workingDirectory: project,
        name: 'Project',
        branch: '',
        workspace: false,
        contextDirectories: [],
      },
    });
  const waitStream = (index: number) => vi.waitUntil(() => streams.length > index, { timeout: 5000, interval: 5 });
  const idle = (id: string) => vi.waitUntil(() => !service.isSessionBusy(id), { timeout: 5000, interval: 5 });
  const finish = (index: number, text = 'Finished') => {
    streams[index].write(frame({ type: 'content', text }));
    streams[index].write(frame('[DONE]'));
  };
  const lastReply = async (id: string) => (await store.get(id))?.messages.at(-1);
  const policyOf = async (id: string) => (await store.get(id))?.orchestrationPolicy;
  const budgeted = async (credits = 500) => {
    const root = await created();
    await service.setSessionOrchestrate(root.id, true, credits);
    return root;
  };
  const notices = (sessionId: string) =>
    events.filter(event => event.type === 'context-notice' && event.sessionId === sessionId);

  it('mints the run with the budget entered when Orchestrate turned on', async () => {
    const root = await budgeted(500);
    expect((await policyOf(root.id))?.budgetCredits).toBe(500);

    await service.send(root.id, 'Plan the work');
    await waitStream(0);

    expect(mint).toHaveBeenCalledWith(expect.any(String), expect.anything(), root.id, 500);
    expect(wire(0).run?.runId).toBe(RUN_A);
    finish(0);
    await idle(root.id);
  });

  it('pauses the run on run_budget_exhausted with a fixed message, without resending unattributed', async () => {
    const root = await budgeted(500);
    budgetState = { budgetCredits: 500, committedCredits: 500, reservedCredits: 40, remainingCredits: 0 };
    completions.mockImplementationOnce(() => Promise.reject(exhausted()));

    await service.send(root.id, 'Plan the work');
    await idle(root.id);

    expect(completions).toHaveBeenCalledTimes(1);
    const reply = await lastReply(root.id);
    expect(reply?.stopReason).toBe(RUN_BUDGET_STOP);
    expect(reply?.error).toBe(
      'Paused: this orchestration run has used its 500-credit budget (460 spent, 40 reserved). Raise the budget to resume; the work so far is kept.'
    );
    expect((await policyOf(root.id))?.budgetPaused).toBe(true);
    // The user's prompt is kept, so the task's progress is intact for the resume.
    expect((await store.get(root.id))?.messages.some(message => message.content === 'Plan the work')).toBe(true);
  });

  it('refuses later turns of a paused run locally, with no request', async () => {
    const root = await budgeted(500);
    completions.mockImplementationOnce(() => Promise.reject(exhausted()));
    await service.send(root.id, 'Plan the work');
    await idle(root.id);

    await service.send(root.id, 'Try again anyway');
    await idle(root.id);

    expect(completions).toHaveBeenCalledTimes(1);
    expect((await lastReply(root.id))?.stopReason).toBe(RUN_BUDGET_STOP);
  });

  it('resumes the paused turn only after the budget is raised', async () => {
    const root = await budgeted(500);
    completions.mockImplementationOnce(() => Promise.reject(exhausted()));
    await service.send(root.id, 'Plan the work');
    await idle(root.id);

    await expect(service.raiseRunBudget(root.id, 1500)).resolves.toEqual({ ok: true, resumed: 1 });
    expect(raise).toHaveBeenCalledWith(BUDGET_PATH, { budgetCredits: 1500 }, expect.anything());
    await waitStream(0);
    expect(wire(1).run?.runId).toBe(RUN_A);
    finish(0, 'Carried on');
    await idle(root.id);

    const policy = await policyOf(root.id);
    expect(policy?.budgetCredits).toBe(1500);
    expect(policy?.budgetPaused).toBeUndefined();
    const reply = await lastReply(root.id);
    expect(reply?.stopReason).not.toBe(RUN_BUDGET_STOP);
    expect(reply?.error).toBeUndefined();
    expect(reply?.content).toContain('Carried on');
  });

  it('stays paused when the new budget is not a raise', async () => {
    const root = await budgeted(500);
    completions.mockImplementationOnce(() => Promise.reject(exhausted()));
    await service.send(root.id, 'Plan the work');
    await idle(root.id);
    raise.mockRejectedValueOnce(
      Object.assign(new Error('Conflict'), {
        isAxiosError: true,
        response: { status: 409, data: { error: 'Not raised', errorCode: 'run_budget_not_raised' } },
      })
    );

    await expect(service.raiseRunBudget(root.id, 400)).resolves.toEqual({
      ok: false,
      error: 'Enter a budget above the current 500 credits.',
    });

    expect(completions).toHaveBeenCalledTimes(1);
    expect((await policyOf(root.id))?.budgetPaused).toBe(true);
  });

  it('never sends a budgeted turn unattributed when the server no longer knows the run', async () => {
    const root = await budgeted(500);
    completions.mockImplementationOnce(() =>
      Promise.reject(rejection(404, { error: 'Run not found', errorCode: 'run_not_found' }))
    );

    await service.send(root.id, 'Plan the work');
    await idle(root.id);

    expect(completions).toHaveBeenCalledTimes(1);
    expect((await lastReply(root.id))?.error).toMatch(/budget cannot be enforced/);
    // Kept, not re-minted: a fresh run would restart the budget at zero.
    expect((await policyOf(root.id))?.serverRunId).toBe(RUN_A);
  });

  it('never resends a budgeted auxiliary call unattributed when the server no longer knows the run', async () => {
    const root = await budgeted(500);
    await service.send(root.id, 'Plan the work');
    await waitStream(0);
    finish(0);
    await idle(root.id);
    const sent = completions.mock.calls.length;
    completions.mockImplementationOnce(() =>
      Promise.reject(rejection(404, { error: 'Run not found', errorCode: 'run_not_found' }))
    );

    await service.suggestNextPrompt(root.id).catch(() => undefined);

    expect(completions).toHaveBeenCalledTimes(sent + 1);
    expect(wire(sent).run?.purpose).toBe('suggestion');
    expect((await policyOf(root.id))?.serverRunId).toBe(RUN_A);
  });

  it('never sends a budgeted turn unattributed when the run cannot be minted', async () => {
    mint.mockResolvedValueOnce(undefined);
    const root = await budgeted(500);

    await service.send(root.id, 'Plan the work');
    await idle(root.id);

    expect(completions).not.toHaveBeenCalled();
    expect((await lastReply(root.id))?.error).toMatch(/budgeted run/);
  });

  it('warns once when the run has committed 80% of its budget, showing spent and reserved', async () => {
    const root = await budgeted(500);
    budgetState = { budgetCredits: 500, committedCredits: 410, reservedCredits: 60, remainingCredits: 90 };

    await service.send(root.id, 'Plan the work');
    await waitStream(0);
    finish(0);
    await idle(root.id);
    await vi.waitUntil(() => notices(root.id).length > 0, { timeout: 5000, interval: 5 });

    expect(notices(root.id)).toEqual([
      {
        type: 'context-notice',
        sessionId: root.id,
        message:
          'This orchestration run has committed 82% of its 500-credit budget (350 spent, 60 reserved, 90 left). It pauses when the budget runs out.',
      },
    ]);

    await service.send(root.id, 'Keep going');
    await waitStream(1);
    finish(1);
    await idle(root.id);
    await vi.waitUntil(() => get.mock.calls.length >= 1, { timeout: 5000 });
    expect(notices(root.id)).toHaveLength(1);
    expect((await policyOf(root.id))?.budgetWarnedAt).toBe(500);
  });

  it('does not warn below 80%', async () => {
    const root = await budgeted(500);
    budgetState = { budgetCredits: 500, committedCredits: 300, reservedCredits: 0, remainingCredits: 200 };

    await service.send(root.id, 'Plan the work');
    await waitStream(0);
    finish(0);
    await idle(root.id);
    await vi.waitUntil(() => get.mock.calls.length >= 1, { timeout: 5000, interval: 5 });

    expect(notices(root.id)).toHaveLength(0);
  });

  it('pauses the whole run when a worker hits the budget, and the raise resumes the worker', async () => {
    const root = await budgeted(500);
    await service.send(root.id, 'Delegate the bounded task');
    await waitStream(0);
    // The worker's first request is refused for the budget; the root's own rounds stream as usual.
    const streamed = completions.getMockImplementation()!;
    let refusedWorker = false;
    completions.mockImplementation((url, rawBody, ...rest) => {
      const body = rawBody as Wire;
      if (body.run?.role === 'worker' && !refusedWorker) {
        refusedWorker = true;
        return Promise.reject(exhausted());
      }
      return streamed(url, body, ...rest);
    });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [
          {
            id: 'spawn-0',
            name: 'session_spawn',
            arguments: JSON.stringify({ prompt: 'Do the task', title: 'Fixed child title', contract }),
          },
        ],
      })
    );
    streams[0].write(frame('[DONE]'));

    const worker = await vi.waitUntil(
      async () => (await store.list()).find(session => session.origin?.parentSessionId === root.id),
      { timeout: 5000, interval: 5 }
    );
    await vi.waitUntil(async () => (await lastReply(worker.id))?.stopReason === RUN_BUDGET_STOP, {
      timeout: 5000,
      interval: 5,
    });
    expect((await policyOf(root.id))?.budgetPaused).toBe(true);
    expect(refusedWorker).toBe(true);
    // The root's next round is over the same budget: refused locally, with no request.
    await vi.waitUntil(() => streams.length > 1 || !service.isSessionBusy(root.id), { timeout: 5000, interval: 5 });
    for (let index = 1; index < streams.length; index += 1) finish(index);
    await idle(root.id);
    const before = completions.mock.calls.length;

    const result = await service.raiseRunBudget(worker.id, 2000);
    expect(result.ok).toBe(true);
    await vi.waitUntil(
      () =>
        completions.mock.calls
          .slice(before)
          .some(([, body]) => (body as Wire).run?.role === 'worker' && (body as Wire).run?.runId === RUN_A),
      { timeout: 5000, interval: 5 }
    );
    expect((await policyOf(root.id))?.budgetCredits).toBe(2000);
    expect((await policyOf(root.id))?.budgetPaused).toBeUndefined();
    for (const stream of streams) stream.end();
  });
});

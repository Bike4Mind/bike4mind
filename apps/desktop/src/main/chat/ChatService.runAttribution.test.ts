import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { CompletionRun, CompletionRunAttribution } from '@bike4mind/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskContract } from '@shared/orchestration';
import type { ChatModelOption } from '@shared/chat';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { CompletionRunMinter } from './completionRuns';
import type { ModelCatalog } from './ModelCatalog';
import type { AccessStore } from './tools/AccessStore';

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
const RUN_A = '7d0c8f3e-2b1a-4c5d-9e8f-0a1b2c3d4e5f';
const frame = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
const run = (runId: string): CompletionRun => ({ runId, createdAt: '2026-11-10T00:00:00.000Z' });
type Wire = { model: string; run?: CompletionRunAttribution };
type PostCall = [string, Wire, { headers?: Record<string, string> }];

describe('orchestration run attribution', () => {
  let store: SessionStore;
  let storeDirectory: string;
  let service: ChatService;
  let deps: ConstructorParameters<typeof ChatService>[0];
  let project: string;
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let mint: ReturnType<typeof vi.fn<CompletionRunMinter>>;

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-run-project-')));
    storeDirectory = await mkdtemp(join(tmpdir(), 'b4m-run-store-'));
    store = new SessionStore(storeDirectory, 'planner');
    const models: ChatModelOption[] = [
      { id: 'planner', name: 'Planner', supportsTools: true },
      { id: 'worker', name: 'Worker', supportsTools: true },
    ];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    mint = vi.fn<CompletionRunMinter>().mockResolvedValue(run(RUN_A));
    deps = {
      store,
      summaryChanged: vi.fn(),
      access: { list: async () => [] } as unknown as AccessStore,
      models: { list: async () => ({ models }), cached: () => models } as unknown as ModelCatalog,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => undefined,
      mintCompletionRun: mint,
    };
    service = new ChatService(deps);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    for (const stream of streams) stream.end();
  });

  const call = (index: number) => post.mock.calls[index] as PostCall;
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
  function finish(index: number, text = 'Finished') {
    streams[index].write(frame({ type: 'content', text }));
    streams[index].write(frame('[DONE]'));
  }
  async function storedRunId(id: string) {
    return (await store.get(id))?.orchestrationPolicy?.serverRunId;
  }

  it('mints a run on the first orchestrated turn and sends the root turn under it', async () => {
    const parent = await created();
    await service.setSessionOrchestrate(parent.id, true);
    expect(mint).not.toHaveBeenCalled();

    await service.send(parent.id, 'Plan the work');
    await waitStream(0);
    expect(mint).toHaveBeenCalledWith(expect.any(String), expect.anything(), parent.id);
    expect(await storedRunId(parent.id)).toBe(RUN_A);
    expect(call(0)[1].run).toEqual({ runId: RUN_A, role: 'root', purpose: 'turn' });
    expect(call(0)[2].headers?.['X-Request-ID']).toBeTruthy();
    finish(0);
    await idle(parent.id);
    expect(mint).toHaveBeenCalledOnce();
  });

  it('sends no run for a session that is not orchestrated', async () => {
    const parent = await created();
    await service.send(parent.id, 'Just a question');
    await waitStream(0);
    expect(call(0)[1]).not.toHaveProperty('run');
    finish(0);
    await idle(parent.id);
    expect(mint).not.toHaveBeenCalled();
  });

  it('sends the turn unattributed when no run can be minted, and a worker that mints later shares it with the root', async () => {
    mint.mockResolvedValueOnce(undefined);
    const parent = await created();
    await service.setSessionOrchestrate(parent.id, true);

    await service.send(parent.id, 'Delegate the bounded task');
    await waitStream(0);
    expect(call(0)[1]).not.toHaveProperty('run');
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [
          {
            id: 'spawn-0',
            name: 'session_spawn',
            arguments: JSON.stringify({ prompt: 'Legacy prompt', title: 'Fixed child title', contract }),
          },
        ],
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => post.mock.calls.some((_entry, index) => call(index)[1].run?.role === 'worker'), {
      timeout: 5000,
    });
    const child = (await store.list()).find(session => session.origin?.parentSessionId === parent.id);
    if (!child?.workerTask) throw new Error('Child not created');
    const workerIndex = post.mock.calls.findIndex((_entry, index) => call(index)[1].run?.role === 'worker');
    expect(call(workerIndex)[1].run).toEqual({
      runId: RUN_A,
      role: 'worker',
      purpose: 'turn',
      taskId: child.id,
      attemptId: child.workerTask.attempts.at(-1)?.id,
      parentSessionId: parent.id,
    });
    expect(await storedRunId(parent.id)).toBe(RUN_A);
    expect(await storedRunId(child.id)).toBe(RUN_A);
  });

  it('drops a run the server refuses and resends the request once without it', async () => {
    const parent = await created();
    await service.setSessionOrchestrate(parent.id, true);
    // A streamed request's error body is a stream too, not a string.
    const envelope = JSON.stringify({ error: 'Run not found', errorCode: 'run_not_found' });
    post.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error('Request failed'), {
          isAxiosError: true,
          response: { status: 404, data: Readable.from([Buffer.from(envelope)]) },
        })
      )
    );

    await service.send(parent.id, 'Plan the work');
    await waitStream(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(call(0)[1].run?.runId).toBe(RUN_A);
    expect(call(1)[1]).not.toHaveProperty('run');
    expect(call(1)[2].headers?.['X-Request-ID']).not.toBe(call(0)[2].headers?.['X-Request-ID']);
    finish(0, 'Still answered');
    await idle(parent.id);

    expect(await storedRunId(parent.id)).toBeUndefined();
    const reply = (await store.get(parent.id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.content).toBe('Still answered');
  });

  it("keeps each round's request id and settled charge without changing its usage", async () => {
    const parent = await created();
    await service.send(parent.id, 'Question');
    await waitStream(0);
    streams[0].write(frame({ type: 'meta', requestId: 'req-1' }));
    streams[0].write(frame({ type: 'content', text: 'Answer', credits: { used: 4 } }));
    streams[0].write(frame({ type: 'settled', requestId: 'req-1', creditsCharged: 5, usdCost: 0.02 }));
    streams[0].write(frame('[DONE]'));
    await idle(parent.id);

    const reply = (await store.get(parent.id))?.messages.find(message => message.role === 'assistant');
    // A plain reply keeps no rounds, so its one request's settlement rides the message.
    expect(reply?.rounds).toBeUndefined();
    expect(reply).toMatchObject({ requestId: 'req-1', settled: { creditsCharged: 5, usdCost: 0.02 } });
    expect(reply?.usage?.creditsUsed).toBe(4);
  });

  it('keeps settlement per round on a reply that ran tools', async () => {
    const parent = await created();
    await service.send(parent.id, 'Question');
    await waitStream(0);
    streams[0].write(frame({ type: 'meta', requestId: 'req-1' }));
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'list-0', name: 'session_list', arguments: '{}' }],
        credits: { used: 2 },
      })
    );
    streams[0].write(frame({ type: 'settled', requestId: 'req-1', creditsCharged: 3 }));
    streams[0].write(frame('[DONE]'));
    await waitStream(1);
    streams[1].write(frame({ type: 'meta', requestId: 'req-2' }));
    streams[1].write(frame({ type: 'content', text: 'Answer', credits: { used: 4 } }));
    streams[1].write(frame({ type: 'settled', requestId: 'req-2', creditsCharged: 5 }));
    streams[1].write(frame('[DONE]'));
    await idle(parent.id);

    const reply = (await store.get(parent.id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.rounds?.map(round => [round.requestId, round.settled, round.usage?.creditsUsed])).toEqual([
      ['req-1', { creditsCharged: 3 }, 2],
      ['req-2', { creditsCharged: 5 }, 4],
    ]);
    expect(reply?.usage?.creditsUsed).toBe(6);
  });

  it('keeps the settled charge of every round a failed turn already made', async () => {
    const parent = await created();
    await service.send(parent.id, 'Question');
    await waitStream(0);
    streams[0].write(frame({ type: 'meta', requestId: 'req-1' }));
    streams[0].write(frame({ type: 'tool_use', tools: [{ id: 'list-0', name: 'session_list', arguments: '{}' }] }));
    streams[0].write(frame({ type: 'settled', requestId: 'req-1', creditsCharged: 3 }));
    streams[0].write(frame('[DONE]'));
    await waitStream(1);
    streams[1].write(frame({ type: 'error', message: 'upstream failed' }));
    await idle(parent.id);

    const reply = (await store.get(parent.id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.error).toContain('upstream failed');
    expect(reply?.rounds?.[0]).toMatchObject({ requestId: 'req-1', settled: { creditsCharged: 3 } });
    expect(reply).not.toHaveProperty('requestId');
  });

  it("keeps a failed single-request turn's settled charge on the message", async () => {
    const parent = await created();
    await service.send(parent.id, 'Question');
    await waitStream(0);
    streams[0].write(frame({ type: 'meta', requestId: 'req-1' }));
    streams[0].write(frame({ type: 'content', text: 'Partial' }));
    streams[0].write(frame({ type: 'settled', requestId: 'req-1', creditsCharged: 2 }));
    streams[0].write(frame({ type: 'error', message: 'upstream failed' }));
    await idle(parent.id);

    const reply = (await store.get(parent.id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.error).toContain('upstream failed');
    expect(reply?.rounds).toBeUndefined();
    expect(reply).toMatchObject({ requestId: 'req-1', settled: { creditsCharged: 2 } });
  });

  it("holds a continued plain reply's first charge in exactly one place", async () => {
    const parent = await created();
    await store.appendMessage(parent.id, { id: 'u1', role: 'user', content: 'Question', createdAt: '2026-11-10' });
    await store.appendMessage(parent.id, {
      id: 'a1',
      role: 'assistant',
      content: 'Answer so far',
      createdAt: '2026-11-10',
      model: 'planner',
      stopReason: 'turn_time_limit',
      requestId: 'req-1',
      settled: { creditsCharged: 5 },
    });

    await service.continueReply(parent.id);
    await waitStream(0);
    streams[0].write(frame({ type: 'meta', requestId: 'req-2' }));
    streams[0].write(frame({ type: 'content', text: 'and the rest' }));
    streams[0].write(frame({ type: 'settled', requestId: 'req-2', creditsCharged: 1 }));
    streams[0].write(frame('[DONE]'));
    await idle(parent.id);

    const reloaded = await new SessionStore(storeDirectory, 'planner').get(parent.id);
    const reply = reloaded?.messages.find(message => message.id === 'a1');
    expect(reply).not.toHaveProperty('requestId');
    expect(reply).not.toHaveProperty('settled');
    expect(reply?.rounds?.map(round => round.requestId)).toEqual(['req-1', 'req-2']);
  });

  it('spawns a worker with the run id the root stored after its turn began', async () => {
    const create = vi.spyOn(store, 'create');
    const parent = await created();
    await service.setSessionOrchestrate(parent.id, true);
    await service.send(parent.id, 'Delegate the bounded task');
    await waitStream(0);
    expect(await storedRunId(parent.id)).toBe(RUN_A);
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [
          {
            id: 'spawn-0',
            name: 'session_spawn',
            arguments: JSON.stringify({ prompt: 'Legacy prompt', title: 'Fixed child title', contract }),
          },
        ],
      })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => create.mock.calls.some(([, init]) => init?.orchestrationPolicy), { timeout: 5000 });
    const spawned = create.mock.calls.find(([, init]) => init?.orchestrationPolicy)?.[1];
    expect(spawned?.orchestrationPolicy?.serverRunId).toBe(RUN_A);
  });

  it("copies the root's run id onto a worker, which keeps it after a restart without minting", async () => {
    const parent = await created();
    await service.setSessionOrchestrate(parent.id, true);
    const rootPolicy = (await store.get(parent.id))?.orchestrationPolicy;
    if (!rootPolicy) throw new Error('No root policy');
    const { serverRunId: _id, ...beforeMint } = rootPolicy;
    const worker = await store.create('worker', {
      title: 'Fixed worker title',
      orchestrationPolicy: beforeMint,
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'Brief' },
    });

    // Each worker request is found by its prompt, not its position: a finished worker turn can wake its parent.
    const sentWith = (prompt: string) => post.mock.calls.findIndex(entry => JSON.stringify(entry[1]).includes(prompt));
    const turn = async (prompt: string) => {
      await service.send(worker.id, prompt);
      await vi.waitUntil(() => sentWith(prompt) >= 0 && streams.length > sentWith(prompt), {
        timeout: 5000,
        interval: 5,
      });
      const index = sentWith(prompt);
      finish(index);
      await idle(worker.id);
      return call(index)[1].run;
    };

    expect(await turn('Do the work')).toMatchObject({ runId: RUN_A, role: 'worker' });
    expect(await storedRunId(worker.id)).toBe(RUN_A);

    // A restart: the root's orchestrate flag expired with its policy, and the in-memory map is new.
    await store.setOrchestrationPolicy(parent.id, undefined);
    service.dispose();
    service = new ChatService({ ...deps, store: new SessionStore(storeDirectory, 'planner') });
    expect(await turn('Carry on')).toMatchObject({ runId: RUN_A, role: 'worker' });
    expect(mint).toHaveBeenCalledOnce();
  });

  it('keeps a newer run id when a refusal of an older one lands late', async () => {
    const parent = await created();
    await service.setSessionOrchestrate(parent.id, true);
    const policy = (await store.get(parent.id))?.orchestrationPolicy;
    if (!policy) throw new Error('No root policy');
    const NEWER = '0f1e2d3c-4b5a-4968-8776-655443322110';
    // NEWER is minted while the request under RUN_A is in flight, then the server refuses RUN_A.
    post.mockImplementationOnce(async () => {
      await store.setServerRunId(parent.id, policy.rootRunId, NEWER);
      throw Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 404, data: JSON.stringify({ error: 'Run not found', errorCode: 'run_not_found' }) },
      });
    });
    await service.send(parent.id, 'Plan the work');
    await waitStream(0);
    expect(call(0)[1].run?.runId).toBe(RUN_A);
    expect(call(1)[1]).not.toHaveProperty('run');
    finish(0);
    await idle(parent.id);
    expect(await storedRunId(parent.id)).toBe(NEWER);
  });
});

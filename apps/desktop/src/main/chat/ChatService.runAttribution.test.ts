import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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
  let service: ChatService;
  let project: string;
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let mint: ReturnType<typeof vi.fn<CompletionRunMinter>>;

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-run-project-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-run-store-')), 'planner');
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
    service = new ChatService({
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
    });
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

  it('mints a run when Orchestrate turns on and sends the root turn under it', async () => {
    const parent = await created();
    await service.setSessionOrchestrate(parent.id, true);
    await vi.waitUntil(async () => (await storedRunId(parent.id)) === RUN_A, { timeout: 5000 });
    expect(mint).toHaveBeenCalledWith(expect.any(String), expect.anything(), parent.id);

    await service.send(parent.id, 'Plan the work');
    await waitStream(0);
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
    mint.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const parent = await created();
    await service.setSessionOrchestrate(parent.id, true);
    await vi.waitUntil(() => mint.mock.calls.length === 1, { timeout: 5000 });

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
    await vi.waitUntil(async () => (await storedRunId(parent.id)) === RUN_A, { timeout: 5000 });
    post.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error('Request failed'), {
          isAxiosError: true,
          response: { status: 404, data: JSON.stringify({ error: 'Run not found', errorCode: 'run_not_found' }) },
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
});

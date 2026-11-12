import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inheritancePolicy, type TaskContract } from '@shared/orchestration';
import type { ChatModelOption, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
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
const frame = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
type Wire = {
  model: string;
  messages: { role: string; content: unknown }[];
  options?: { tools?: { toolSchema: { name: string; parameters: { properties: Record<string, unknown> } } }[] };
};

describe('role routing and task runtime compatibility', () => {
  let store: SessionStore;
  let service: ChatService;
  let project: string;
  let models: ChatModelOption[];
  let streams: PassThrough[];
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let directory: string;
  let summaryChanged: ReturnType<typeof vi.fn<(summary: ChatSessionSummary) => void>>;
  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-orchestration-project-')));
    directory = await mkdtemp(join(tmpdir(), 'b4m-orchestration-store-'));
    store = new SessionStore(directory, 'planner');
    summaryChanged = vi.fn<(summary: ChatSessionSummary) => void>();
    models = [
      { id: 'planner', name: 'Planner', supportsTools: true },
      { id: 'worker', name: 'Worker', supportsTools: true },
      { id: 'reviewer', name: 'Reviewer', supportsTools: true },
    ];
    streams = [];
    events = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    service = new ChatService({
      store,
      summaryChanged,
      access: { list: async () => [] } as unknown as AccessStore,
      models: { list: async () => ({ models }), cached: () => models } as unknown as ModelCatalog,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    for (const stream of streams) stream.end();
  });
  const wire = (index: number) => post.mock.calls[index][1] as Wire;
  async function created(mode: 'chat' | 'code' = 'code') {
    return store.create('planner', {
      title: 'Fixed test title',
      mode,
      ...(mode === 'code'
        ? {
            project: {
              directory: project,
              workingDirectory: project,
              name: 'Project',
              branch: '',
              workspace: false,
              contextDirectories: [],
            },
          }
        : {}),
    });
  }
  async function waitStream(index: number) {
    await vi.waitUntil(() => streams.length > index, { timeout: 5000, interval: 5 });
  }
  function tool(index: number, name: string, input: unknown) {
    streams[index].write(
      frame({ type: 'tool_use', tools: [{ id: `${name}-${index}`, name, arguments: JSON.stringify(input) }] })
    );
    streams[index].write(frame('[DONE]'));
  }
  function finish(index: number, text = 'Finished') {
    streams[index].write(frame({ type: 'content', text }));
    streams[index].write(frame('[DONE]'));
  }
  async function idle(id: string) {
    await vi.waitUntil(() => !service.isSessionBusy(id), { timeout: 5000, interval: 5 });
  }
  async function spawn(parent: ChatSessionSummary, input: Record<string, unknown>) {
    const index = streams.length;
    await service.send(parent.id, 'Delegate the bounded task');
    await waitStream(index);
    tool(index, 'session_spawn', { prompt: 'Legacy prompt', title: 'Fixed child title', ...input });
    await vi.waitUntil(
      () =>
        events.some(
          event => event.type === 'tool-end' && event.sessionId === parent.id && event.call.name === 'session_spawn'
        ),
      { timeout: 5000, interval: 5 }
    );
    return (await store.list()).find(session => session.origin?.parentSessionId === parent.id);
  }
  async function policy() {
    await service.setRolePolicy({
      ...inheritancePolicy(),
      roles: { implementation: 'worker', exploration: 'reviewer', review: 'inherit' },
      allowedOverrides: ['reviewer'],
      escalation: {
        mode: 'ask',
        allowedModels: ['reviewer', 'planner'],
        allowedRoles: ['implementation'],
        maxAutomaticUpgrades: 0,
      },
    });
  }

  it.each(['chat', 'code'] as const)(
    'ordinary %s sends and follow-ups stream without task machinery or extra paid calls',
    async mode => {
      const parent = await created(mode);
      await service.send(parent.id, 'First question');
      await waitStream(0);
      expect(post).toHaveBeenCalledTimes(1);
      expect(wire(0).model).toBe('planner');
      expect(JSON.stringify(wire(0).messages)).not.toContain('Task contract');
      const names = wire(0).options?.tools?.map(entry => entry.toolSchema.name) ?? [];
      expect(names).not.toContain('task_report');
      expect(names).not.toContain('task_assess');
      expect(names).not.toContain('quest_complete');
      finish(0, 'Streamed answer');
      await idle(parent.id);
      await service.send(parent.id, 'Follow-up');
      await waitStream(1);
      expect(post).toHaveBeenCalledTimes(2);
      expect(wire(1).model).toBe('planner');
      finish(1);
      await idle(parent.id);
      expect(
        (await store.get(parent.id))?.messages
          .filter(message => message.role === 'assistant')
          .map(message => message.content)
      ).toEqual(['Streamed answer', 'Finished']);
    }
  );

  it('toggles Orchestrate off without stale worker policy, prompts, forms or paid planner calls', async () => {
    const parent = await created();
    await policy();
    await service.setSessionOrchestrate(parent.id, true);
    expect((await store.get(parent.id))?.orchestrationPolicy?.policy.roles.implementation).toBe('worker');
    await service.setSessionOrchestrate(parent.id, false);
    expect((await store.get(parent.id))?.orchestrationPolicy).toBeUndefined();
    await service.send(parent.id, 'An ordinary request');
    await waitStream(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(wire(0).model).toBe('planner');
    expect(JSON.stringify(wire(0))).not.toContain('task_assess');
    expect(JSON.stringify(wire(0))).not.toContain('The user turned on Orchestrate');
    expect(
      wire(0).options?.tools?.find(entry => entry.toolSchema.name === 'session_spawn')?.toolSchema.parameters.properties
    ).not.toHaveProperty('contract');
    finish(0);
    await idle(parent.id);
  });

  it('routes a structured child and nested roles from the root snapshot while defaults and toggles change', async () => {
    const parent = await created();
    await policy();
    await service.setSessionOrchestrate(parent.id, true);
    const child = await spawn(parent, { contract });
    expect(child?.model).toBe('worker');
    if (!child) throw new Error('Child not created');
    await vi.waitUntil(() => post.mock.calls.some((_call, index) => wire(index).model === 'worker'), { timeout: 5000 });
    expect((await store.get(parent.id))?.model).toBe('planner');
    expect(child.workerSelection).toMatchObject({
      role: 'implementation',
      source: 'role-policy',
      effectiveModel: 'worker',
    });
    expect(child.workerTask?.contract).toEqual(contract);
    expect(child.origin?.seedPrompt).toContain('Focused test passes');
    expect(child.origin?.seedPrompt).not.toContain('Delegate the bounded task');
    await service.setRolePolicy(inheritancePolicy());
    await service.setSessionOrchestrate(parent.id, false);
    expect((await store.get(child.id))?.orchestrationPolicy?.policy.roles.exploration).toBe('reviewer');
    expect((await store.get(child.id))?.model).toBe('worker');
    const restarted = new SessionStore(directory, 'planner');
    expect((await restarted.get(child.id))?.workerSelection).toEqual(child.workerSelection);
    const workerIndex = post.mock.calls.findIndex((_call, index) => wire(index).model === 'worker');
    const schema = wire(workerIndex).options?.tools?.find(entry => entry.toolSchema.name === 'session_spawn');
    expect(schema?.toolSchema.parameters.properties).toHaveProperty('role');
    models = models.filter(model => model.id !== 'worker');
    service.stop(child.id);
    finish(workerIndex);
    await idle(child.id);
    const count = post.mock.calls.length;
    const refused = await service.send(child.id, 'Resume on the saved worker');
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('blocked') });
    expect(post.mock.calls.length).toBe(count);
    expect((await store.get(child.id))?.model).toBe('worker');
  });

  it.each([
    { requested_model_id: 'forbidden', role: 'implementation' },
    { requested_model_id: 'planner', role: 'implementation' },
    { contract: { ...contract, outcome: '' } },
    { role: 'implementation', model_requirements: { vision: true } },
    { role: 'implementation', model_requirements: { contextTokens: 1000000 } },
  ])('rejects invalid or unauthorized delegation before creating a paid child', async input => {
    const parent = await created();
    await policy();
    await service.setSessionOrchestrate(parent.id, true);
    expect(await spawn(parent, input)).toBeUndefined();
    expect(post.mock.calls.every((_call, index) => wire(index).model === 'planner')).toBe(true);
    expect(
      events.some(
        event => event.type === 'tool-end' && event.call.name === 'session_spawn' && event.call.status === 'error'
      )
    ).toBe(true);
  });

  it('resolves a family alias to the newest allowed catalog model and offers the field only when overrides exist', async () => {
    models.push(
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', releaseDate: '2026-02-01', supportsTools: true },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', releaseDate: '2026-09-01', supportsTools: true }
    );
    const spawnField = (index: number) =>
      wire(index).options?.tools?.find(entry => entry.toolSchema.name === 'session_spawn')?.toolSchema.parameters
        .properties.requested_model_id;

    const closed = await created();
    await service.setRolePolicy({
      ...inheritancePolicy(),
      roles: { ...inheritancePolicy().roles, implementation: 'worker' },
    });
    await service.setSessionOrchestrate(closed.id, true);
    const refusedIndex = streams.length;
    expect(await spawn(closed, { role: 'implementation', requested_model_id: 'sonnet' })).toBeUndefined();
    expect(spawnField(refusedIndex)).toBeUndefined();
    const refusal = events.find(
      event => event.type === 'tool-end' && event.sessionId === closed.id && event.call.name === 'session_spawn'
    );
    expect(refusal?.type === 'tool-end' && refusal.call.error).toMatch(
      /^Model request refused: 'sonnet' is not an allowed override \(allowed: none\)\. Nothing was started\. Omit requested_model_id to use the role default \(worker\)/
    );

    const open = await created();
    await service.setRolePolicy({
      ...inheritancePolicy(),
      roles: { ...inheritancePolicy().roles, implementation: 'worker' },
      allowedOverrides: ['claude-sonnet-4-6', 'claude-sonnet-5'],
    });
    await service.setSessionOrchestrate(open.id, true);
    const openIndex = streams.length;
    const child = await spawn(open, { role: 'implementation', requested_model_id: 'sonnet' });
    expect(spawnField(openIndex)).toMatchObject({ description: expect.stringContaining('claude-sonnet-5') });
    expect(child?.model).toBe('claude-sonnet-5');
    expect((await store.get(child?.id ?? ''))?.workerSelection).toMatchObject({
      requestedModelId: 'sonnet',
      effectiveModel: 'claude-sonnet-5',
      source: 'override',
    });
  });

  it('persists escalation evidence; denial and duplicate delivery make no paid attempt; parent acceptance requires passing results', async () => {
    const parent = await created();
    await policy();
    await service.setSessionOrchestrate(parent.id, true);
    const child = await spawn(parent, { contract });
    if (!child) throw new Error('No child');
    await vi.waitUntil(() => post.mock.calls.some((_call, index) => wire(index).model === 'worker'), { timeout: 5000 });
    const workerIndex = post.mock.calls.findIndex((_call, index) => wire(index).model === 'worker');
    const report = {
      status: 'escalation-requested' as const,
      decisionId: 'decision-1',
      reason: 'Assumption disproven',
      evidence: ['Focused test proves interface mismatch'],
      requestedModelId: 'reviewer',
    };
    tool(workerIndex, 'task_report', { report });
    await vi.waitUntil(async () => (await store.get(child.id))?.workerTask?.state.status === 'escalation-requested', {
      timeout: 5000,
    });
    await vi.waitUntil(() => post.mock.calls.filter((_call, index) => wire(index).model === 'worker').length === 2, {
      timeout: 5000,
    });
    const lastWorker = post.mock.calls.findLastIndex((_call, index) => wire(index).model === 'worker');
    finish(lastWorker, 'Need the smallest interface decision');
    await idle(child.id);
    const count = post.mock.calls.length;
    await service.actOnTask(null, child.id, { kind: 'deny', reason: 'Clarify instead', decisionId: 'decision-1' });
    await service.actOnTask(null, child.id, { kind: 'deny', reason: 'Duplicate', decisionId: 'decision-1' });
    expect(post.mock.calls.length).toBe(count);
    expect((await store.get(child.id))?.workerTask?.state).toMatchObject({
      status: 'blocked',
      evidence: report.evidence,
    });
    await expect(service.actOnTask(parent.id, child.id, { kind: 'accept', assessment: 'Turn ended' })).rejects.toThrow(
      /Acceptance/
    );
    await expect(
      service.actOnTask(child.id, child.id, {
        kind: 'report',
        report: {
          status: 'completed',
          changedPaths: ['src/feature.ts'],
          verification: [
            { criterion: 'Targeted tests', command: 'pnpm test feature', outcome: 'passed', evidence: '1 test passed' },
          ],
          unmetCriteria: [],
          handoff: 'Labelled by command',
        },
      })
    ).rejects.toThrow(/Not covered:\n- "Focused test passes"/);
    expect((await store.get(child.id))?.workerTask?.state).toMatchObject({ status: 'blocked' });
    await service.actOnTask(child.id, child.id, {
      kind: 'report',
      report: {
        status: 'completed',
        changedPaths: [],
        verification: [
          {
            criterion: 'Focused test passes',
            command: 'pnpm test feature',
            outcome: 'failed',
            evidence: '1 assertion failed',
          },
        ],
        unmetCriteria: [],
        handoff: 'Check failed',
      },
    });
    await expect(
      service.actOnTask(parent.id, child.id, { kind: 'accept', assessment: 'Ignore failure' })
    ).rejects.toThrow(/Acceptance/);
    await service.actOnTask(child.id, child.id, {
      kind: 'report',
      report: {
        status: 'completed',
        changedPaths: ['src/feature.ts'],
        verification: [
          {
            criterion: 'Focused test passes',
            command: 'pnpm test feature',
            outcome: 'passed',
            evidence: '1 test passed',
          },
        ],
        unmetCriteria: [],
        handoff: 'Verified the bounded behavior',
      },
    });
    await service.actOnTask(parent.id, child.id, { kind: 'accept', assessment: 'Reviewed the focused evidence' });
    expect((await store.get(child.id))?.workerTask?.state).toMatchObject({ status: 'completed', accepted: true });
    expect((await store.get(child.id))?.workerTask?.attempts).toHaveLength(1);
    expect(summaryChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: child.id,
        workerTask: expect.objectContaining({ state: expect.objectContaining({ accepted: true }) }),
      })
    );
    const nextIndex = streams.length;
    await service.send(child.id, 'Change the implementation again');
    await waitStream(nextIndex);
    expect((await store.get(child.id))?.workerTask?.state).toEqual({ status: 'running' });
    expect((await store.get(child.id))?.workerTask?.attempts).toHaveLength(2);
    finish(nextIndex);
    await idle(child.id);
    await vi.waitUntil(async () => (await store.get(child.id))?.workerTask?.state.status === 'blocked', {
      timeout: 5000,
    });
  });
  it('lets a managed worker assess its own nested task using the same root snapshot without enabling ungated spawn', async () => {
    const parent = await created();
    await policy();
    await service.setSessionOrchestrate(parent.id, true);
    const child = await spawn(parent, { contract });
    if (!child) throw new Error('No child');
    await vi.waitUntil(() => post.mock.calls.some((_call, index) => wire(index).model === 'worker'), { timeout: 5000 });
    const childIndex = post.mock.calls.findIndex((_call, index) => wire(index).model === 'worker');
    expect(wire(childIndex).options?.tools?.map(entry => entry.toolSchema.name)).toContain('task_assess');
    const grandchild = await store.create('reviewer', {
      title: 'Nested task',
      project: child.project,
      origin: { parentSessionId: child.id, depth: 2, seedPrompt: 'Nested brief' },
      orchestrationPolicy: child.orchestrationPolicy,
      workerSelection: {
        role: 'exploration',
        effectiveModel: 'reviewer',
        source: 'role-policy',
        rootRunId: child.orchestrationPolicy!.rootRunId,
      },
      workerTask: {
        version: 1,
        contract: { ...contract, role: 'exploration' },
        automaticUpgrades: 0,
        resolvedDecisions: [],
        attempts: [{ id: 'nested-1', model: 'reviewer', startedAt: '2026-11-07', trigger: 'initial' }],
        state: {
          status: 'completed',
          accepted: false,
          changedPaths: [],
          verification: [
            {
              criterion: 'Focused test passes',
              command: 'inspect interface',
              outcome: 'passed',
              evidence: 'Verified source interface',
            },
          ],
          unmetCriteria: [],
          handoff: 'Evidence ready',
        },
      },
    });
    const accepted = await service.actOnTask(child.id, grandchild.id, {
      kind: 'accept',
      assessment: 'Reviewed nested evidence',
    });
    expect(accepted.workerTask?.state).toMatchObject({ status: 'completed', accepted: true });
    expect((await store.get(child.id))?.orchestrate).toBeUndefined();
  });
  it('honors permitted overrides and records a single explicit task upgrade without changing the planner', async () => {
    const parent = await created();
    await policy();
    await service.setSessionOrchestrate(parent.id, true);
    const child = await spawn(parent, { contract, requested_model_id: 'reviewer' });
    if (!child) throw new Error('No child');
    expect(child.model).toBe('reviewer');
    expect(child.workerSelection?.source).toBe('override');
    await vi.waitUntil(() => post.mock.calls.some((_call, index) => wire(index).model === 'reviewer'), {
      timeout: 5000,
    });
    const childIndex = post.mock.calls.findIndex((_call, index) => wire(index).model === 'reviewer');
    finish(childIndex);
    await idle(child.id);
    await vi.waitUntil(async () => (await store.get(child.id))?.workerTask?.state.status === 'blocked', {
      timeout: 5000,
    });
    await service.actOnTask(child.id, child.id, {
      kind: 'report',
      report: {
        status: 'escalation-requested',
        decisionId: 'upgrade-one',
        reason: 'Need a targeted review',
        evidence: ['Shared interface assumption disproven'],
        requestedModelId: 'planner',
      },
    });
    const count = post.mock.calls.length;
    await service.actOnTask(null, child.id, { kind: 'upgrade', modelId: 'planner', decisionId: 'upgrade-one' });
    await vi.waitUntil(() => post.mock.calls.length > count, { timeout: 5000 });
    const upgraded = await store.get(child.id);
    expect(upgraded?.workerTask?.attempts).toHaveLength(2);
    expect(upgraded?.workerTask?.attempts[1].trigger).toBe('user-upgrade');
    expect(upgraded?.workerSelection?.source).toBe('escalation');
    expect(upgraded?.workerSelection?.effectiveModel).toBe('planner');
    expect((await store.get(parent.id))?.model).toBe('planner');
    const afterUpgrade = post.mock.calls.length;
    await expect(
      service.actOnTask(parent.id, child.id, { kind: 'upgrade', modelId: 'planner', decisionId: 'upgrade-one' })
    ).rejects.toThrow(/model cannot approve/);
    expect(post.mock.calls.length).toBe(afterUpgrade);
    await service.actOnTask(null, child.id, { kind: 'cancel', reason: 'User canceled' });
    expect(post.mock.calls.length).toBe(afterUpgrade);
    expect((await store.get(child.id))?.workerTask?.state.status).toBe('canceled');
  });
  it('does not let a late worker report overwrite a user cancellation', async () => {
    const parent = await created();
    await policy();
    await service.setSessionOrchestrate(parent.id, true);
    const child = await spawn(parent, { contract });
    if (!child) throw new Error('No child');
    await vi.waitUntil(() => post.mock.calls.some((_call, index) => wire(index).model === 'worker'), { timeout: 5000 });
    const mutate = store.updateWorkerTask.bind(store);
    vi.spyOn(store, 'updateWorkerTask').mockImplementationOnce(async (id, change, scope, model) => {
      await mutate(
        id,
        task => ({ ...task, state: { status: 'canceled', reason: 'User canceled concurrently' } }),
        scope
      );
      return mutate(id, change, scope, model);
    });
    await expect(
      service.actOnTask(child.id, child.id, {
        kind: 'report',
        report: { status: 'blocked', reason: 'Late result', evidence: ['Earlier attempt evidence'] },
      })
    ).rejects.toThrow(/settled/);
    expect((await store.get(child.id))?.workerTask?.state).toMatchObject({ status: 'canceled' });
  });
  it('refuses Continue after a cancellation while its catalog validation was waiting', async () => {
    const parent = await created();
    await policy();
    await service.setSessionOrchestrate(parent.id, true);
    const child = await spawn(parent, { contract });
    if (!child) throw new Error('No child');
    await vi.waitUntil(() => post.mock.calls.some((_call, index) => wire(index).model === 'worker'), { timeout: 5000 });
    const childIndex = post.mock.calls.findIndex((_call, index) => wire(index).model === 'worker');
    finish(childIndex);
    await idle(child.id);
    await vi.waitUntil(async () => (await store.get(child.id))?.workerTask?.state.status === 'blocked', {
      timeout: 5000,
    });
    await store.appendMessage(child.id, {
      id: 'resumable',
      role: 'assistant',
      content: 'Partial result',
      stopReason: 'tool_turn_limit',
      createdAt: new Date().toISOString(),
    });
    let releaseCatalog: ((catalog: { models: ChatModelOption[] }) => void) | undefined;
    const pendingCatalog = new Promise<{ models: ChatModelOption[] }>(resolve => {
      releaseCatalog = resolve;
    });
    const listing = vi.spyOn(service, 'listModels').mockReturnValueOnce(pendingCatalog);
    const continuing = service.continueReply(child.id);
    await vi.waitUntil(() => listing.mock.calls.length === 1);
    await service.actOnTask(null, child.id, { kind: 'cancel', reason: 'User canceled during catalog validation' });
    const calls = post.mock.calls.length;
    releaseCatalog?.({ models });
    expect(await continuing).toMatchObject({ ok: false, error: expect.stringMatching(/canceled/) });
    expect(post.mock.calls.length).toBe(calls);
    expect((await store.get(child.id))?.workerTask?.state.status).toBe('canceled');
  });
});

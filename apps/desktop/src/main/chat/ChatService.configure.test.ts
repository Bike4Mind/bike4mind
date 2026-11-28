import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelOption, ChatSessionSummary } from '@shared/chat';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionActivity } from './SessionActivity';
import { SessionStore } from './SessionStore';
import type { ModelCatalog } from './ModelCatalog';
import type { AccessStore } from './tools/AccessStore';

const models: ChatModelOption[] = [
  { id: 'worker', name: 'Worker', supportsTools: true },
  { id: 'reviewer', name: 'Reviewer', supportsTools: true },
];

describe('ChatService.configureSession on a worker', () => {
  let store: SessionStore;
  let service: ChatService;
  let summaries: ChatSessionSummary[];
  let workerId: string;

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-configure-service-')), 'worker');
    summaries = [];
    service = new ChatService({
      store,
      activity: new SessionActivity(() => undefined),
      queue: new MessageQueue(() => undefined),
      access: { list: async () => [] } as unknown as AccessStore,
      models: { list: async () => ({ models }), cached: () => models } as unknown as ModelCatalog,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => ({ get: vi.fn().mockResolvedValue({}) }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => undefined,
      summaryChanged: summary => summaries.push(summary),
    });
    const worker = await store.create('worker', {
      workerSelection: { role: 'implementation', effectiveModel: 'worker', source: 'override', rootRunId: 'run' },
      workerTask: {
        version: 1,
        contract: {
          version: 1,
          outcome: 'Bounded task',
          rationale: 'Focused scope',
          role: 'implementation',
          paths: [],
          contextReferences: [],
          ownedChanges: [],
          coordinationConstraints: [],
          nonGoals: [],
          acceptanceCriteria: ['Observed result'],
          verification: [],
          assumptions: [],
          escalationConditions: [],
        },
        automaticUpgrades: 0,
        resolvedDecisions: [],
        attempts: [{ id: 'attempt', model: 'worker', startedAt: '2026-11-19', trigger: 'initial' }],
        state: { status: 'running' },
      },
    });
    workerId = worker.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
  });

  /** The worker's turn is in flight, which refuses an explicit model change. */
  const midTurn = () =>
    vi
      .spyOn(service as unknown as { hasTurnInFlight(id: string): boolean }, 'hasTurnInFlight')
      .mockImplementation(id => id === workerId);

  it('applies a changed effort beside the current model, queueing no new attempt', async () => {
    const summary = await service.configureSession(workerId, { model: 'worker', reasoningEffort: 'high' });

    expect(summary).toMatchObject({ id: workerId, reasoningEffort: 'high' });
    const stored = await store.get(workerId);
    expect(stored?.workerTask?.attempts).toHaveLength(1);
    expect(stored?.workerTask?.state.status).toBe('running');
    expect(summaries.map(changed => changed.id)).toEqual([workerId]);
  });

  it('accepts that patch while a turn is in flight, and still refuses a changed model then', async () => {
    midTurn();

    await expect(
      service.configureSession(workerId, { model: 'worker', reasoningEffort: 'high' })
    ).resolves.toMatchObject({
      reasoningEffort: 'high',
    });
    await expect(service.configureSession(workerId, { model: 'reviewer' })).rejects.toThrow(/Stop the worker attempt/);
    expect((await store.get(workerId))?.model).toBe('worker');
  });

  it('changes nothing and tells no one for a patch of current values', async () => {
    await store.setReasoningEffort(workerId, 'high');
    await store.setApprovalMode(workerId, 'ask');
    const before = await store.get(workerId);

    const summary = await service.configureSession(workerId, {
      model: 'worker',
      reasoningEffort: 'high',
      approvalMode: 'ask',
    });

    expect(summary).toMatchObject({ id: workerId, model: 'worker', reasoningEffort: 'high', approvalMode: 'ask' });
    expect(await store.get(workerId)).toEqual(before);
    expect(summaries).toEqual([]);
  });
});

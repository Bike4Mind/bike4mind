import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatModels } from '@bike4mind/common';
import { summarizeSession } from '@shared/agentOutcome';
import type { ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

const frame = (payload: unknown): string =>
  `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

const todoCall = (id: string, statuses: string[]) => ({
  type: 'tool_use',
  tools: [
    {
      id,
      name: 'todo_write',
      arguments: JSON.stringify({ todos: statuses.map((status, i) => ({ content: `Step ${i + 1}`, status })) }),
    },
  ],
});

describe('ChatService live plan', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let summaries: ChatSessionSummary[];
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let store: SessionStore;

  beforeEach(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-liveplan-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-liveplan-sessions-')), 'test-model');
    events = [];
    summaries = [];
    streams = [];
    const opened = streams;
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    const emitted = events;
    const pushed = summaries;
    const boundPost = post;
    service = new ChatService({
      store,
      models: {
        list: async () => ({
          models: [
            { id: 'test-model', name: 'Test', backend: 'anthropic' },
            { id: ChatModels.CLAUDE_5_SONNET, name: 'Sonnet', backend: 'anthropic' },
          ],
        }),
        cached: () => [],
      } as unknown as ModelCatalog,
      access: { list: async () => [root] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
      summaryChanged: summary => pushed.push(summary),
    });
  });

  const nextRequest = (n: number) => vi.waitUntil(() => streams.length === n, { timeout: 3000, interval: 5 });
  const planOf = (summary: ChatSessionSummary | undefined) => summary?.plan?.done + '/' + summary?.plan?.total;

  const endTurn = async (stream: PassThrough) => {
    const before = events.filter(event => event.type === 'done').length;
    stream.write(frame({ type: 'content', text: 'ok' }));
    stream.write(frame('[DONE]'));
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length > before, {
      timeout: 3000,
      interval: 5,
    });
  };
  // livePlans is private; the clear-at-turn-end contract is only observable through it.
  const overlaid = (id: string) => (service as unknown as { livePlans: Map<string, unknown> }).livePlans.has(id);
  const listed = async (id: string) => (await service.listSessions()).find(entry => entry.id === id);

  it('overlays the live plan on every summary and list mid-turn, then hands over to the stored one', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'do it');
    await nextRequest(1);
    streams[0].write(frame(todoCall('c1', ['in_progress', 'pending'])));
    streams[0].write(frame('[DONE]'));
    await nextRequest(2);
    await vi.waitUntil(() => summaries.some(summary => summary.plan), { timeout: 3000, interval: 5 });
    expect(planOf(summaries.findLast(summary => summary.plan))).toBe('0/2');

    streams[1].write(frame(todoCall('c2', ['completed', 'in_progress'])));
    streams[1].write(frame('[DONE]'));
    await nextRequest(3);
    await vi.waitUntil(() => planOf(summaries.at(-1)) === '1/2', { timeout: 3000, interval: 5 });

    // The reply is not stored yet, so a summary built from the store alone has no plan.
    const pushed = summaries.length;
    await service.setSessionHistory(id, false);
    expect(summaries.length).toBeGreaterThan(pushed);
    expect(summaries.at(-1)?.plan).toMatchObject({ done: 1, total: 2, current: 'Step 2' });
    expect((await listed(id))?.plan).toMatchObject({ done: 1, total: 2 });

    await endTurn(streams[2]);
    expect(overlaid(id)).toBe(false);
    const stored = await store.get(id);
    const storedPlan = stored && summarizeSession(stored).plan;
    expect(storedPlan).toMatchObject({ done: 1, total: 2 });
    await vi.waitUntil(() => summaries.at(-1)?.plan !== undefined && summaries.length > pushed + 1, {
      timeout: 3000,
      interval: 5,
    });
    expect(summaries.at(-1)?.plan).toEqual(storedPlan);
    expect((await listed(id))?.plan).toEqual(storedPlan);
  });

  it('keeps a plan from before a context boundary through the next turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'plan it');
    await nextRequest(1);
    streams[0].write(frame(todoCall('c1', ['completed', 'pending'])));
    streams[0].write(frame('[DONE]'));
    await nextRequest(2);
    await endTurn(streams[1]);
    expect(await service.clearContext(id)).toMatchObject({ ok: true });

    await service.send(id, 'again');
    await nextRequest(3);
    streams[2].write(frame({ type: 'tool_use', tools: [{ id: 'c2', name: 'not_a_real_tool', arguments: '{}' }] }));
    streams[2].write(frame('[DONE]'));
    await nextRequest(4);

    await service.setSessionHistory(id, false);
    expect(summaries.at(-1)?.plan).toMatchObject({ done: 1, total: 2 });
    await endTurn(streams[3]);
    expect(overlaid(id)).toBe(false);
  });

  it('returns the live plan from the setters while the turn is running', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'do it');
    await nextRequest(1);
    streams[0].write(frame(todoCall('c1', ['completed', 'in_progress', 'pending'])));
    streams[0].write(frame('[DONE]'));
    await nextRequest(2);
    await vi.waitUntil(() => planOf(summaries.at(-1)) === '1/3', { timeout: 3000, interval: 5 });

    expect((await service.setSessionPinned(id, true))?.plan).toMatchObject({ done: 1, total: 3 });
    expect((await service.renameSession(id, 'Renamed'))?.plan).toMatchObject({ done: 1, total: 3 });
    expect((await service.setSessionArchived(id, false))?.plan).toMatchObject({ done: 1, total: 3 });
  });

  it('returns the live plan when a context folder is added or removed mid-turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'do it');
    await nextRequest(1);
    streams[0].write(frame(todoCall('c1', ['completed', 'in_progress', 'pending'])));
    streams[0].write(frame('[DONE]'));
    await nextRequest(2);
    await vi.waitUntil(() => planOf(summaries.at(-1)) === '1/3', { timeout: 3000, interval: 5 });

    const folder = await realpath(await mkdtemp(join(tmpdir(), 'b4m-liveplan-folder-')));
    const added = await service.shareDirectory(id, folder);
    expect(added.status === 'added' && added.session?.plan).toMatchObject({ done: 1, total: 3 });
    expect((await service.removeContextDirectory(id, folder, false))?.plan).toMatchObject({ done: 1, total: 3 });
  });

  it('hands over to the stored plan when the turn errors', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'do it');
    await nextRequest(1);
    streams[0].write(frame(todoCall('c1', ['completed', 'pending'])));
    streams[0].write(frame('[DONE]'));
    await nextRequest(2);
    await vi.waitUntil(() => overlaid(id), { timeout: 3000, interval: 5 });
    const pushed = summaries.length;

    streams[1].destroy(new Error('the server fell over'));
    await vi.waitUntil(() => events.some(event => event.type === 'error'), { timeout: 3000, interval: 5 });
    expect(overlaid(id)).toBe(false);
    const stored = await store.get(id);
    const storedPlan = stored && summarizeSession(stored).plan;
    expect(storedPlan).toMatchObject({ done: 1, total: 2 });
    await vi.waitUntil(() => summaries.length > pushed, { timeout: 3000, interval: 5 });
    expect(summaries.at(-1)?.plan).toEqual(storedPlan);
  });

  it('pushes no summary for a tool round that leaves the plan alone', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await nextRequest(1);
    streams[0].write(frame({ type: 'tool_use', tools: [{ id: 'c1', name: 'not_a_real_tool', arguments: '{}' }] }));
    streams[0].write(frame('[DONE]'));
    await nextRequest(2);
    const pushed = summaries.length;
    streams[1].write(frame({ type: 'tool_use', tools: [{ id: 'c2', name: 'not_a_real_tool', arguments: '{}' }] }));
    streams[1].write(frame('[DONE]'));
    await nextRequest(3);
    expect(summaries.length).toBe(pushed);
    expect(summaries.every(summary => summary.plan === undefined)).toBe(true);
  });
});

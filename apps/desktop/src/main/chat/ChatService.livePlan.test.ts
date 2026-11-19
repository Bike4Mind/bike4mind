import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatModels } from '@bike4mind/common';
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

  it('pushes plan progress per plan call mid-turn, keeps it over other summaries, and hands over at settle', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'do it');
    await nextRequest(1);
    streams[0].write(frame(todoCall('c1', ['in_progress', 'pending'])));
    streams[0].write(frame('[DONE]'));

    await nextRequest(2);
    await vi.waitUntil(() => summaries.some(summary => summary.plan), { timeout: 3000, interval: 5 });
    expect(planOf(summaries.findLast(summary => summary.plan))).toBe('0/2');

    // Another summary pushed mid-turn must not revert the plan to the (empty) stored one.
    await service.setSessionModel(id, ChatModels.CLAUDE_5_SONNET);
    expect(summaries.at(-1)?.plan).toMatchObject({ done: 0, total: 2, current: 'Step 1', next: 'Step 2' });

    streams[1].write(frame(todoCall('c2', ['completed', 'in_progress'])));
    streams[1].write(frame('[DONE]'));
    await nextRequest(3);
    await vi.waitUntil(() => planOf(summaries.at(-1)) === '1/2', { timeout: 3000, interval: 5 });

    streams[2].write(frame({ type: 'content', text: 'done' }));
    streams[2].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });

    // After the turn the stored transcript carries the same plan, and nothing is overlaid any more.
    const stored = await store.get(id);
    expect(stored && (await import('@shared/agentOutcome')).summarizeSession(stored).plan).toMatchObject({
      done: 1,
      total: 2,
    });
    await service.setSessionModel(id, 'test-model');
    expect(planOf(summaries.at(-1))).toBe('1/2');
  });

  it('pushes nothing extra for a turn without a plan', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await nextRequest(1);
    streams[0].write(frame({ type: 'content', text: 'hello' }));
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(summaries.every(summary => summary.plan === undefined)).toBe(true);
  });
});

import type { ChatSessionStatusEvent, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionActivity } from './SessionActivity';
import type { ModelCatalog } from './ModelCatalog';
import type { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function summary(id: string, minute: number): ChatSessionSummary {
  const at = new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  return {
    id,
    title: `Session ${id}`,
    mode: 'chat',
    createdAt: at,
    updatedAt: at,
    messageCount: 0,
  } as ChatSessionSummary;
}

describe('ChatService.listSessionPage', () => {
  let service: ChatService;
  let activity: SessionActivity;
  const list = vi.fn();
  const events: ChatSessionStatusEvent[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    events.length = 0;
    // s0 is newest, s2 oldest.
    list.mockReset().mockImplementation(async () => [summary('s2', 1), summary('s0', 3), summary('s1', 2)]);
    activity = new SessionActivity(event => events.push(event));
    service = new ChatService({
      store: { list } as unknown as SessionStore,
      activity,
      access: { list: async () => [] } as unknown as AccessStore,
      models: { list: async () => ({ models: [] }), cached: () => [] } as unknown as ModelCatalog,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => undefined,
    });
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  it('lists afresh for a first page, every time', async () => {
    await service.listSessionPage({ limit: 1 });
    await service.listSessionPage({ limit: 1 });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('serves cursor pages from the snapshot while it is under ten seconds old, then lists again', async () => {
    const first = await service.listSessionPage({ limit: 1 });
    expect(first.sessions.map(session => session.id)).toEqual(['s0']);

    vi.advanceTimersByTime(9_000);
    const second = await service.listSessionPage({ limit: 1, cursor: first.nextCursor });
    expect(second.sessions.map(session => session.id)).toEqual(['s1']);
    expect(list).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await service.listSessionPage({ limit: 1, cursor: second.nextCursor });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('lists once for a run of searches, and again after the snapshot expires', async () => {
    const page = await service.listSessionPage({ limit: 1, query: 'session' });
    expect(page.nextCursor).not.toBeNull();
    await service.listSessionPage({ limit: 1, query: 'session', cursor: page.nextCursor });
    await service.listSessionPage({ limit: 1, query: 'sess' });
    expect(list).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(11_000);
    await service.listSessionPage({ limit: 1, query: 'session' });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('sends a busy session on the first page only, and never a finished one with a background job', async () => {
    activity.replyStarted('s2');
    activity.replyStarted('s1');
    activity.replyEnded('s1');
    // Done but still holding a background job: listed as 'done' by sessionStatuses().
    activity.backgroundChanged('s1', { running: 1, label: 'sleep 60' });

    const first = await service.listSessionPage({ limit: 1 });
    expect(first.sessions.map(session => session.id)).toEqual(['s0']);
    expect(first.related.map(session => session.id)).toEqual(['s2']);

    const second = await service.listSessionPage({ limit: 1, cursor: first.nextCursor });
    expect(second.sessions.map(session => session.id)).toEqual(['s1']);
    expect(second.related).toEqual([]);
  });
});

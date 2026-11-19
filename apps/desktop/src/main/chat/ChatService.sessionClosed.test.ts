import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { SessionActivity } from './SessionActivity';

describe('ChatService sessionClosed', () => {
  let service: ChatService;
  let closed: string[];
  let store: SessionStore;
  let activity: SessionActivity;

  beforeEach(async () => {
    closed = [];
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-closed-sessions-')), 'test-model');
    activity = new SessionActivity(() => undefined);
    service = new ChatService({
      store,
      activity,
      access: { list: async () => [] } as unknown as AccessStore,
      models: {
        list: async () => ({ models: [{ id: 'test-model', name: 'Test', backend: 'openai' }] }),
        cached: () => [],
      } as unknown as ModelCatalog,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => undefined,
      sessionClosed: sessionId => closed.push(sessionId),
    });
  });

  afterEach(() => service.dispose());

  it('announces a deleted session', async () => {
    const { id } = await service.createSession();
    await service.deleteSession(id);
    expect(closed).toEqual([id]);
  });

  it('drops a deleted session from the sidebar sections, even when that fails', async () => {
    const forgetSession = vi.fn(() => Promise.reject(new Error('disk full')));
    const sections = new ChatService({
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-closed-sections-')), 'test-model'),
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => undefined,
      sidebarSections: { forgetSession },
    });
    const { id } = await sections.createSession();

    await expect(sections.deleteSession(id)).resolves.toBeUndefined();
    expect(forgetSession).toHaveBeenCalledWith(id);
    sections.dispose();
  });

  it('announces an archived session, and not an unarchived one', async () => {
    const { id } = await service.createSession();
    await service.setSessionArchived(id, true);
    await service.setSessionArchived(id, false);
    expect(closed).toEqual([id]);
  });

  it('archives only finished children and preserves unrelated sessions', async () => {
    const parent = await store.create();
    const child = () =>
      store.create(undefined, { origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'test' } });
    const finished = await child();
    const running = await child();
    const waiting = await child();
    const unrelated = await store.create();
    activity.replyStarted(running.id);
    activity.approvalRequested(waiting.id);
    await service.archiveFinishedChildren(
      parent.id,
      [finished.id, running.id, waiting.id, unrelated.id],
      store.scopeKey()
    );
    expect((await store.get(finished.id))?.archived).toBe(true);
    for (const entry of [running, waiting, unrelated, parent])
      expect((await store.get(entry.id))?.archived).toBeUndefined();
    expect(closed).toEqual([finished.id]);
  });

  it('rechecks a child that resumes while its archive mutation is queued', async () => {
    const parent = await store.create();
    const child = await store.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'test' },
    });
    const setArchived = store.setArchived.bind(store);
    vi.spyOn(store, 'setArchived').mockImplementation(async (...args) => {
      activity.approvalRequested(child.id);
      return setArchived(...args);
    });
    await service.archiveFinishedChildren(parent.id, [child.id], store.scopeKey());
    expect((await store.get(child.id))?.archived).toBeUndefined();
    expect(closed).toEqual([]);
  });
});

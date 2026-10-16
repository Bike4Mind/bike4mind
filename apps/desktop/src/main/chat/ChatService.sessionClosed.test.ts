import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

describe('ChatService sessionClosed', () => {
  let service: ChatService;
  let closed: string[];

  beforeEach(async () => {
    closed = [];
    service = new ChatService({
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-closed-sessions-')), 'test-model'),
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

  it('announces an archived session, and not an unarchived one', async () => {
    const { id } = await service.createSession();
    await service.setSessionArchived(id, true);
    await service.setSessionArchived(id, false);
    expect(closed).toEqual([id]);
  });
});

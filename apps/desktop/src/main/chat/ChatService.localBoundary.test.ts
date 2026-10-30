import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { ChatService } from './ChatService';
import type { CompletionRequest } from './completions';
import { MessageQueue } from './MessageQueue';
import { LocalHistory } from './LocalHistory';
import type { ModelCatalog } from './ModelCatalog';
import type { OllamaLocal } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import type { CompletionStreamEvent } from './streamEvents';
import type { AccessStore } from './tools/AccessStore';
import type { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';

const LOCAL_MODEL = 'local:ollama:qwen3:8b';
const OTHER_RUNTIME_MODEL = 'local:lmstudio:some-model';
const services: ChatService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

async function fixture(
  stream: OllamaLocal['stream'],
  options: { history?: LocalHistory; background?: BackgroundProcessRegistry } = {}
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'b4m-local-boundary-project-')));
  const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-local-boundary-')), LOCAL_MODEL);
  const events: ChatStreamEvent[] = [];
  const hostedStreams: PassThrough[] = [];
  const post = vi.fn(async () => {
    const stream = new PassThrough();
    hostedStreams.push(stream);
    return { data: stream, status: 200 };
  });
  const api = {
    get: vi.fn(async () => ({})),
    getAxiosInstance: () => ({ post }),
  } as unknown as AuthenticatedApiClient;
  const option = { id: LOCAL_MODEL, name: 'Local', backend: 'local-ollama', supportsTools: true };
  const queue = new MessageQueue(() => undefined);
  const service = new ChatService({
    store,
    ...options,
    queue,
    models: {
      list: async () => ({ models: [option, { id: 'hosted', name: 'Hosted', supportsTools: true }] }),
      listLocal: async () => [option],
      cached: () => [option, { id: 'hosted', name: 'Hosted', supportsTools: true }],
    } as unknown as ModelCatalog,
    local: { stream } as OllamaLocal,
    access: { list: async () => [] } as unknown as AccessStore,
    artifacts: new ArtifactPublisher(() => api, { debug: vi.fn() }),
    logger: { debug: vi.fn(), warn: vi.fn() },
    getApiClient: () => api,
    getEnvironmentUrl: () => 'https://hosted.example.com',
    emit: event => events.push(event),
  });
  services.push(service);
  async function create(model = LOCAL_MODEL) {
    const result = await service.createCodeSession({ directory, workspace: false, branch: '' });
    if (!result.ok) throw new Error(result.error);
    await service.setSessionModel(result.session.id, model);
    await service.renameSession(result.session.id, 'User chosen title');
    return result.session.id;
  }
  return { store, service, events, post, hostedStreams, queue, create };
}

const settled = (events: ChatStreamEvent[], sessionId: string) =>
  vi.waitUntil(() => events.find(event => event.type === 'done' && event.sessionId === sessionId));

describe('device-local conversation boundary', () => {
  it('keeps generated artifacts on device while signed in', async () => {
    const { service, store, events, post, create } = await fixture(async (_request, emit) => {
      emit({
        type: 'content',
        text: '<artifact type="text/html" title="Private">private local document</artifact>',
        stopReason: 'end_turn',
      });
    });
    const id = await create();
    await service.send(id, 'make a private document');
    await settled(events, id);
    expect((await store.get(id))?.messages.at(-1)?.artifacts).toMatchObject([
      { title: 'Private', content: 'private local document' },
    ]);
    expect(post).not.toHaveBeenCalled();
  });

  it('settles a stopped local stream as an aborted reply, preserving partial text', async () => {
    const { service, store, events, create } = await fixture(async (_request, emit, signal) => {
      emit({ type: 'content', text: 'Partial local answer' });
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const id = await create();
    await service.send(id, 'start replying');
    await vi.waitUntil(() => events.some(event => event.type === 'delta'));
    service.stop(id);
    await settled(events, id);
    expect((await store.get(id))?.messages.at(-1)).toMatchObject({
      content: 'Partial local answer',
      stopReason: 'aborted',
    });
    expect((await store.get(id))?.messages.at(-1)?.error).toBeUndefined();
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it.each([LOCAL_MODEL, OTHER_RUNTIME_MODEL])(
    'refuses a relay from %s to a hosted session before queueing or uploading its contents',
    async localModel => {
      let targetId = '';
      let rounds = 0;
      const { service, store, events, post, queue, create } = await fixture(async (_request, emit) => {
        if (rounds++ === 0) {
          emit({
            type: 'tool_use',
            tools: [
              {
                id: 'send-private',
                name: 'session_send',
                arguments: JSON.stringify({ session_id: targetId, message: 'private local message' }),
              },
            ],
          });
        } else emit({ type: 'content', text: 'Kept here', stopReason: 'end_turn' });
      });
      const sourceId = await create(localModel);
      targetId = await create('hosted');
      await service.send(sourceId, 'hand this over');
      await settled(events, sourceId);
      expect((await store.get(sourceId))?.messages.at(-1)?.toolCalls?.[0]).toMatchObject({
        status: 'error',
        error: expect.stringContaining('cannot send messages to a hosted model'),
      });
      expect(queue.list(targetId)).toEqual([]);
      expect((await store.get(targetId))?.messages).toEqual([]);
      expect(post).not.toHaveBeenCalled();
    }
  );

  it('still delivers a hosted relay to a local session', async () => {
    const { service, store, events, hostedStreams, create } = await fixture(async (_request, emit) => {
      emit({ type: 'content', text: 'Handled locally', stopReason: 'end_turn' });
    });
    const sourceId = await create('hosted');
    const targetId = await create();
    await service.send(sourceId, 'hand this over');
    await vi.waitUntil(() => hostedStreams.length === 1);
    hostedStreams[0].end(
      `data: ${JSON.stringify({ type: 'tool_use', tools: [{ id: 'send-local', name: 'session_send', arguments: JSON.stringify({ session_id: targetId, message: 'public message' }) }] })}\n\ndata: [DONE]\n\n`
    );
    await settled(events, targetId);
    expect((await store.get(targetId))?.messages[0]).toMatchObject({
      content: 'public message',
      relay: { fromSessionId: sourceId },
    });
    await vi.waitUntil(() => hostedStreams.length === 2);
    expect(JSON.stringify((await store.get(sourceId))?.messages)).not.toContain('Local conversation');
    expect(events.find(event => event.type === 'tool-end' && event.sessionId === sourceId)).toMatchObject({
      call: { label: 'Messaged @Local conversation: public message' },
    });
  });

  it.each([LOCAL_MODEL, OTHER_RUNTIME_MODEL])('refuses hosted session_read of a %s transcript', async localModel => {
    const { service, store, events, post, hostedStreams, create } = await fixture(async () => undefined);
    const sourceId = await create('hosted');
    const targetId = await create(localModel);
    await store.appendMessage(targetId, {
      id: 'private-prompt',
      role: 'user',
      content: 'private local transcript',
      createdAt: new Date().toISOString(),
    });
    await service.send(sourceId, 'read the other conversation');
    await vi.waitUntil(() => hostedStreams.length === 1);
    hostedStreams[0].end(
      `data: ${JSON.stringify({ type: 'tool_use', tools: [{ id: 'read-local', name: 'session_read', arguments: JSON.stringify({ session_id: targetId }) }] })}\n\ndata: [DONE]\n\n`
    );
    await vi.waitUntil(() => hostedStreams.length === 2);
    expect(JSON.stringify(post.mock.calls)).not.toContain('private local transcript');
    hostedStreams[1].end('data: {"type":"content","text":"Cannot read it"}\n\ndata: [DONE]\n\n');
    await settled(events, sourceId);
    expect((await store.get(sourceId))?.messages.at(-1)?.toolCalls?.[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('cannot read a device-local conversation'),
    });
  });

  it('redacts a local title from hosted listing and archive results', async () => {
    const { service, store, events, post, hostedStreams, create } = await fixture(async () => undefined);
    const sourceId = await create('hosted');
    const targetId = await create();
    await service.renameSession(targetId, 'Private local title');
    await service.send(sourceId, 'list and archive conversations');
    await vi.waitUntil(() => hostedStreams.length === 1);
    hostedStreams[0].end(
      `data: ${JSON.stringify({
        type: 'tool_use',
        tools: [
          { id: 'list', name: 'session_list', arguments: '{}' },
          { id: 'archive', name: 'session_archive', arguments: JSON.stringify({ session_id: targetId }) },
        ],
      })}\n\ndata: [DONE]\n\n`
    );
    await vi.waitUntil(() => hostedStreams.length === 2);
    expect(JSON.stringify(post.mock.calls)).not.toContain('Private local title');
    expect(JSON.stringify(post.mock.calls)).toContain('Local conversation');
    hostedStreams[1].end('data: {"type":"content","text":"Archived"}\n\ndata: [DONE]\n\n');
    await settled(events, sourceId);
    expect((await store.get(targetId))?.archived).toBe(true);
  });

  it('redacts a local title when a hosted relay is refused because the target is archived', async () => {
    const { service, store, events, post, hostedStreams, queue, create } = await fixture(async () => undefined);
    const sourceId = await create('hosted');
    const targetId = await create();
    await service.renameSession(targetId, 'Private archived local title');
    await service.setSessionArchived(targetId, true);
    await service.send(sourceId, 'send to the archived conversation');
    await vi.waitUntil(() => hostedStreams.length === 1);
    hostedStreams[0].end(
      `data: ${JSON.stringify({
        type: 'tool_use',
        tools: [
          {
            id: 'send-archived',
            name: 'session_send',
            arguments: JSON.stringify({ session_id: targetId, message: 'public message' }),
          },
        ],
      })}\n\ndata: [DONE]\n\n`
    );
    await vi.waitUntil(() => hostedStreams.length === 2);
    expect(JSON.stringify(post.mock.calls)).not.toContain('Private archived local title');
    expect(JSON.stringify(post.mock.calls)).toContain('Local conversation');
    expect(queue.list(targetId)).toEqual([]);
    hostedStreams[1].end('data: {"type":"content","text":"Restore it first"}\n\ndata: [DONE]\n\n');
    await settled(events, sourceId);
    expect((await store.get(sourceId))?.messages.at(-1)?.toolCalls?.[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('"Local conversation" is archived'),
    });
  });

  it('does not reindex a reply after history is opted out during its stream', async () => {
    const history = new LocalHistory(':memory:');
    let finish: (() => void) | undefined;
    const { service, events, create } = await fixture(
      async (_request, emit) => {
        await new Promise<void>(resolve => {
          finish = resolve;
        });
        emit({ type: 'content', text: 'private completion', stopReason: 'end_turn' });
      },
      { history }
    );
    try {
      const id = await create();
      await service.setSessionHistory(id, true);
      await service.send(id, 'private pending prompt');
      await vi.waitUntil(() => finish);
      await service.setSessionHistory(id, false);
      finish?.();
      await settled(events, id);
      expect(history.state()).toEqual({ entries: 0 });
    } finally {
      history.close();
    }
  });

  it.each(['opt-out', 'clear'] as const)(
    'does not restore history when %s finishes during an enable read',
    async action => {
      const history = new LocalHistory(':memory:');
      const { service, store, create } = await fixture(async () => undefined, { history });
      try {
        const id = await create();
        const get = store.get.bind(store);
        let finishRead: (() => void) | undefined;
        vi.spyOn(store, 'get')
          .mockImplementationOnce(get)
          .mockImplementationOnce(async sessionId => {
            const snapshot = await get(sessionId);
            await new Promise<void>(resolve => {
              finishRead = resolve;
            });
            return snapshot;
          });
        const enabling = service.setSessionHistory(id, true);
        await vi.waitUntil(() => finishRead);
        if (action === 'opt-out') await service.setSessionHistory(id, false);
        else history.clear();
        finishRead?.();
        await enabling;
        expect(history.state()).toEqual({ entries: 0 });
        if (action === 'opt-out') expect((await get(id))?.historyEnabled).toBeUndefined();
      } finally {
        history.close();
      }
    }
  );

  it('keeps a later opt-out when an earlier enable is still reading the old preference', async () => {
    const history = new LocalHistory(':memory:');
    const { service, store, create } = await fixture(async () => undefined, { history });
    try {
      const id = await create();
      const get = store.get.bind(store);
      let finishRead: (() => void) | undefined;
      vi.spyOn(store, 'get').mockImplementationOnce(async sessionId => {
        const snapshot = await get(sessionId);
        await new Promise<void>(resolve => {
          finishRead = resolve;
        });
        return snapshot;
      });
      const enabling = service.setSessionHistory(id, true);
      await vi.waitUntil(() => finishRead);
      await service.setSessionHistory(id, false);
      finishRead?.();
      expect(await enabling).toBeNull();
      expect((await get(id))?.historyEnabled).toBeUndefined();
      expect(history.state()).toEqual({ entries: 0 });
    } finally {
      history.close();
    }
  });

  it('does not roll back a newer preference after an earlier capture fails', async () => {
    const history = new LocalHistory(':memory:');
    const { service, store, create } = await fixture(async () => undefined, { history });
    try {
      const id = await create();
      vi.spyOn(history, 'captureSession').mockImplementationOnce(() => {
        throw new Error('index failed');
      });
      const setHistoryEnabled = store.setHistoryEnabled.bind(store);
      let releaseRollback: (() => void) | undefined;
      vi.spyOn(store, 'setHistoryEnabled')
        .mockImplementationOnce(setHistoryEnabled)
        .mockImplementationOnce(async (...args) => {
          await new Promise<void>(resolve => {
            releaseRollback = resolve;
          });
          return setHistoryEnabled(...args);
        });
      const failure = expect(service.setSessionHistory(id, true)).rejects.toThrow('index failed');
      await vi.waitUntil(() => releaseRollback);
      await service.setSessionHistory(id, true);
      releaseRollback?.();
      await failure;
      expect((await store.get(id))?.historyEnabled).toBe(true);
      expect(history.state()).toEqual({ entries: 1 });
    } finally {
      history.close();
    }
  });

  it('does not change consent after the account switches during its initial read', async () => {
    let scope = 'account-a';
    const history = new LocalHistory(':memory:', () => scope);
    const { service, store, create } = await fixture(async () => undefined, { history });
    try {
      const id = await create();
      vi.spyOn(store, 'scopeKey').mockImplementation(() => scope);
      const get = store.get.bind(store);
      vi.spyOn(store, 'get').mockImplementationOnce(async sessionId => {
        const snapshot = await get(sessionId);
        scope = 'account-b';
        return snapshot;
      });
      expect(await service.setSessionHistory(id, true)).toBeNull();
      expect((await get(id))?.historyEnabled).toBeUndefined();
      expect(history.state()).toEqual({ entries: 0 });
    } finally {
      history.close();
    }
  });

  it('removes history reindexed by a reply settling during deletion cleanup', async () => {
    const history = new LocalHistory(':memory:');
    let releaseCleanup: (() => void) | undefined;
    const background = {
      list: () => [],
      killSession: vi.fn(async () => {
        await new Promise<void>(resolve => {
          releaseCleanup = resolve;
        });
      }),
    } as unknown as BackgroundProcessRegistry;
    const { service, events, store, create } = await fixture(
      async (_request, emit, signal) => {
        emit({ type: 'content', text: 'private partial reply' });
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      },
      { history, background }
    );
    try {
      const id = await create();
      await service.setSessionHistory(id, true);
      await service.send(id, 'private prompt');
      await vi.waitUntil(() => events.some(event => event.type === 'delta'));
      const deleting = service.deleteSession(id);
      await settled(events, id);
      await vi.waitUntil(() => releaseCleanup);
      releaseCleanup?.();
      await deleting;
      expect(await store.get(id)).toBeNull();
      expect(history.state()).toEqual({ entries: 0 });
    } finally {
      history.close();
    }
  });

  it.each([LOCAL_MODEL, OTHER_RUNTIME_MODEL])(
    'withholds a %s child error when its parent has switched to a hosted model',
    async localModel => {
      let parentId = '';
      let parentRounds = 0;
      let failChild: (() => void) | undefined;
      const { service, store, events, create } = await fixture(
        async (request: CompletionRequest, emit: (event: CompletionStreamEvent) => void) => {
          if (request.sessionId !== parentId) {
            await new Promise<void>((_resolve, reject) => {
              failChild = () => reject(new Error('private local failure details'));
            });
            return;
          }
          if (parentRounds++ === 0) {
            emit({
              type: 'tool_use',
              tools: [
                {
                  id: 'suggest-child',
                  name: 'session_spawn',
                  arguments: JSON.stringify({ prompt: 'Private local task', title: 'Private task title' }),
                },
              ],
            });
          } else emit({ type: 'content', text: 'Suggested', stopReason: 'end_turn' });
        }
      );
      parentId = await create(localModel);
      await service.send(parentId, 'suggest a child');
      await settled(events, parentId);
      await vi.waitUntil(() => !service.isSessionBusy(parentId));
      const suggestion = (await store.get(parentId))?.spawnSuggestions?.[0];
      if (!suggestion) throw new Error('Missing suggestion');
      expect(
        await service.startSpawnSuggestion({
          sessionId: parentId,
          suggestionId: suggestion.id,
          prompt: suggestion.prompt,
          title: suggestion.title,
          placement: 'local',
        })
      ).toMatchObject({ ok: true });
      await vi.waitUntil(() => failChild);
      await service.setSessionModel(parentId, 'hosted');
      failChild?.();
      await vi.waitUntil(() => events.some(event => event.type === 'message' && event.sessionId === parentId));
      const report = (await store.get(parentId))?.messages.at(-1);
      expect(report?.content).toBe('A device-local child session finished. Open that conversation to read its report.');
      expect(JSON.stringify(report)).not.toContain('private local failure details');
      expect(JSON.stringify(report)).not.toContain('Private task title');
    }
  );
});

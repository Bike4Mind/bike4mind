import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { type ChatModelOption, type ChatStreamEvent, localBackend, localModelId, NO_LOCAL_MODEL } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { ChatService, toolPromptOverflow } from './ChatService';
import type { CompletionRequest } from './completions';
import { MessageQueue } from './MessageQueue';
import { LocalHistory } from './LocalHistory';
import type { ModelCatalog } from './ModelCatalog';
import { LocalModelRemovedError, OLLAMA_RUNTIME_ID, type OllamaLocal, toMessages } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import type { CompletionStreamEvent } from './streamEvents';
import type { AccessStore } from './tools/AccessStore';
import type { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import { estimateTokens } from './localContext';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

describe('localBoundary', () => {
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
    vi.waitUntil(() => events.find(event => event.type === 'done' && event.sessionId === sessionId), { interval: 5 });

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
      await vi.waitUntil(() => events.some(event => event.type === 'delta'), { interval: 5 });
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
      await vi.waitUntil(() => hostedStreams.length === 1, { interval: 5 });
      hostedStreams[0].end(
        `data: ${JSON.stringify({ type: 'tool_use', tools: [{ id: 'send-local', name: 'session_send', arguments: JSON.stringify({ session_id: targetId, message: 'public message' }) }] })}\n\ndata: [DONE]\n\n`
      );
      await settled(events, targetId);
      expect((await store.get(targetId))?.messages[0]).toMatchObject({
        content: 'public message',
        relay: { fromSessionId: sourceId },
      });
      await vi.waitUntil(() => hostedStreams.length === 2, { interval: 5 });
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
      await vi.waitUntil(() => hostedStreams.length === 1, { interval: 5 });
      hostedStreams[0].end(
        `data: ${JSON.stringify({ type: 'tool_use', tools: [{ id: 'read-local', name: 'session_read', arguments: JSON.stringify({ session_id: targetId }) }] })}\n\ndata: [DONE]\n\n`
      );
      await vi.waitUntil(() => hostedStreams.length === 2, { interval: 5 });
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
      await vi.waitUntil(() => hostedStreams.length === 1, { interval: 5 });
      hostedStreams[0].end(
        `data: ${JSON.stringify({
          type: 'tool_use',
          tools: [
            { id: 'list', name: 'session_list', arguments: '{}' },
            { id: 'archive', name: 'session_archive', arguments: JSON.stringify({ session_id: targetId }) },
          ],
        })}\n\ndata: [DONE]\n\n`
      );
      await vi.waitUntil(() => hostedStreams.length === 2, { interval: 5 });
      expect(JSON.stringify(post.mock.calls)).not.toContain('Private local title');
      expect(JSON.stringify(post.mock.calls)).toContain('Local conversation');
      hostedStreams[1].end('data: {"type":"content","text":"Archived"}\n\ndata: [DONE]\n\n');
      await settled(events, sourceId);
      expect((await store.get(targetId))?.archived).toBe(true);
    });

    it('does not let a hosted session address a local conversation by its stored title', async () => {
      const { service, store, events, hostedStreams, queue, create } = await fixture(async () => undefined);
      const sourceId = await create('hosted');
      const targetId = await create();
      await service.renameSession(targetId, 'Private local title');
      await service.send(sourceId, 'send by title');
      await vi.waitUntil(() => hostedStreams.length === 1, { interval: 5 });
      hostedStreams[0].end(
        `data: ${JSON.stringify({
          type: 'tool_use',
          tools: [
            {
              id: 'send-by-title',
              name: 'session_send',
              arguments: JSON.stringify({ session_id: 'Private local title', message: 'public message' }),
            },
          ],
        })}\n\ndata: [DONE]\n\n`
      );
      await vi.waitUntil(() => hostedStreams.length === 2, { interval: 5 });
      expect(queue.list(targetId)).toEqual([]);
      expect((await store.get(targetId))?.messages).toEqual([]);
      hostedStreams[1].end('data: {"type":"content","text":"No such conversation"}\n\ndata: [DONE]\n\n');
      await settled(events, sourceId);
      expect((await store.get(sourceId))?.messages.at(-1)?.toolCalls?.[0]).toMatchObject({ status: 'error' });
    });

    it('redacts a local title when a hosted relay is refused because the target is archived', async () => {
      const { service, store, events, post, hostedStreams, queue, create } = await fixture(async () => undefined);
      const sourceId = await create('hosted');
      const targetId = await create();
      await service.renameSession(targetId, 'Private archived local title');
      await service.setSessionArchived(targetId, true);
      await service.send(sourceId, 'send to the archived conversation');
      await vi.waitUntil(() => hostedStreams.length === 1, { interval: 5 });
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
      await vi.waitUntil(() => hostedStreams.length === 2, { interval: 5 });
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
        await vi.waitUntil(() => finish, { interval: 5 });
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
          await vi.waitUntil(() => finishRead, { interval: 5 });
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
        await vi.waitUntil(() => finishRead, { interval: 5 });
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
        await vi.waitUntil(() => releaseRollback, { interval: 5 });
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
        await vi.waitUntil(() => events.some(event => event.type === 'delta'), { interval: 5 });
        const deleting = service.deleteSession(id);
        await settled(events, id);
        await vi.waitUntil(() => releaseCleanup, { interval: 5 });
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
        let childId = '';
        const { service, store, events, create } = await fixture(
          async (request: CompletionRequest, emit: (event: CompletionStreamEvent) => void) => {
            if (request.sessionId !== parentId) {
              childId = request.sessionId ?? '';
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
        await vi.waitUntil(() => !service.isSessionBusy(parentId), { interval: 5 });
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
        await vi.waitUntil(() => failChild, { interval: 5 });
        await service.setSessionModel(parentId, 'hosted');
        failChild?.();
        await vi.waitUntil(() => events.some(event => event.type === 'message' && event.sessionId === parentId), {
          interval: 5,
        });
        const report = (await store.get(parentId))?.messages.at(-1);
        expect(report?.content).toBe(
          'A device-local child session finished. Open that conversation to read its report.'
        );
        expect(report?.childReport).toBeUndefined();
        expect(report?.reportedChildId).toBe(childId);
        expect(JSON.stringify(report)).not.toContain('private local failure details');
        expect(JSON.stringify(report)).not.toContain('Private task title');
      }
    );
  });
});

describe('signedOutLocal', () => {
  const HOSTED_DEFAULT = 'claude-hosted-default';
  const option = (name: string): ChatModelOption => ({
    id: localModelId(OLLAMA_RUNTIME_ID, name),
    name,
    backend: localBackend(OLLAMA_RUNTIME_ID),
    supportsTools: true,
  });
  const QWEN = option('qwen2.5:0.5b');
  const GEMMA = option('gemma3:270m');
  const services: ChatService[] = [];

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
  });

  type Mode = 'signed-in' | 'device-local' | 'expired';

  async function fixture(options: {
    mode: Mode;
    local: ChatModelOption[];
    remembered?: string | null;
    /** The catalog's last local list; left out, the catalog has no lastLocal at all. */
    last?: ChatModelOption[] | null;
  }) {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-signed-out-local-')), HOSTED_DEFAULT);
    const events: ChatStreamEvent[] = [];
    const stream = vi.fn<OllamaLocal['stream']>(async (_request, emit) => {
      emit({ type: 'content', text: 'hi', stopReason: 'end_turn' });
    });
    const api = {
      get: vi.fn(async () => ({})),
      getAxiosInstance: () => ({ post: vi.fn() }),
    } as unknown as AuthenticatedApiClient;
    const local = { current: options.local };
    const record = vi.fn(async () => {});
    const last = { current: options.last ?? null };
    // Like ModelCatalog: a read refreshes the last list, and forgetLocal drops it.
    const listLocal = vi.fn(async (_force?: boolean) => {
      last.current = local.current;
      return local.current;
    });
    const forgetLocal = vi.fn(() => {
      last.current = null;
    });
    const service = new ChatService({
      store,
      queue: new MessageQueue(() => undefined),
      models: {
        list: async () => ({ models: local.current }),
        listLocal,
        cached: () => local.current,
        forgetLocal,
        ...(options.last === undefined ? {} : { lastLocal: () => last.current }),
      } as unknown as ModelCatalog,
      modelMemory: { read: async () => options.remembered ?? null, record },
      local: { stream } as unknown as OllamaLocal,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      preferredModel: HOSTED_DEFAULT,
      getApiClient: () => (options.mode === 'signed-in' ? api : null),
      isDeviceLocal: () => options.mode === 'device-local',
      getEnvironmentUrl: () => 'https://hosted.example.com',
      emit: event => events.push(event),
    });
    services.push(service);
    const settled = (id: string) =>
      vi.waitUntil(() => events.some(e => e.type === 'done' && e.sessionId === id), { interval: 5 });
    return { service, store, stream, local, events, record, settled, listLocal, forgetLocal };
  }

  describe('device-local chat with no usable local model', () => {
    it('starts conversations on the placeholder, never the hosted default', async () => {
      const { service } = await fixture({ mode: 'device-local', local: [] });
      expect((await service.createSession()).model).toBe(NO_LOCAL_MODEL);
      expect(await service.modelForNewSession()).toBe(NO_LOCAL_MODEL);
    });

    it('refuses a send, stores no message, and streams nothing', async () => {
      const { service, store, stream } = await fixture({ mode: 'device-local', local: [] });
      const session = await service.createSession();
      expect(await service.send(session.id, 'hello')).toMatchObject({
        ok: false,
        error: expect.stringContaining('No local model'),
      });
      expect(stream).not.toHaveBeenCalled();
      expect((await store.get(session.id))?.messages).toEqual([]);
    });

    it('moves a hosted conversation to a local model once one exists, with a notice', async () => {
      const { service, store, stream, local, settled } = await fixture({ mode: 'device-local', local: [] });
      const session = await service.createSession();
      await service.setSessionModel(session.id, 'claude-opus-5');
      expect(await service.send(session.id, 'hello')).toMatchObject({ ok: false });

      local.current = [QWEN];
      const result = await service.send(session.id, 'hello');
      expect(result).toMatchObject({
        ok: true,
        notice: expect.stringContaining('Switched this conversation to qwen2.5:0.5b'),
      });
      await settled(session.id);
      expect((await store.get(session.id))?.model).toBe(QWEN.id);
      expect(stream.mock.calls.every(([request]) => request.model === QWEN.id)).toBe(true);
    });

    it('sends on the last local list without asking Ollama when it has the model, however old', async () => {
      const { service, listLocal, settled } = await fixture({ mode: 'device-local', local: [QWEN], last: [QWEN] });
      const session = await service.createSession();
      expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
      await settled(session.id);
      expect(await service.send(session.id, 'again')).toMatchObject({ ok: true });
      await vi.waitUntil(() => !service.isSessionBusy(session.id), { interval: 5 });
      expect(listLocal).not.toHaveBeenCalled();
    });

    it('rereads once, forced, when the last list lacks the model, then switches as before', async () => {
      const { service, store, listLocal, settled } = await fixture({
        mode: 'device-local',
        local: [GEMMA],
        last: [QWEN, GEMMA],
      });
      const session = await service.createSession();
      await service.setSessionModel(session.id, localModelId(OLLAMA_RUNTIME_ID, 'llama3.2'));
      expect(await service.send(session.id, 'hello')).toMatchObject({
        ok: true,
        notice: expect.stringContaining('llama3.2 is not available on this device'),
      });
      await settled(session.id);
      expect(listLocal.mock.calls).toEqual([[true]]);
      expect((await store.get(session.id))?.model).toBe(GEMMA.id);
    });

    it('reads Ollama once when there is no last list yet', async () => {
      const { service, listLocal, settled } = await fixture({ mode: 'device-local', local: [QWEN], last: null });
      const session = await service.createSession();
      expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
      await settled(session.id);
      expect(listLocal.mock.calls).toEqual([[true]]);
    });

    it('forgets the list when the model was removed outside the app, so the next send switches', async () => {
      const { service, store, stream, local, listLocal, forgetLocal } = await fixture({
        mode: 'device-local',
        local: [QWEN, GEMMA],
        last: [QWEN, GEMMA],
      });
      const session = await service.createSession();
      await service.setSessionModel(session.id, QWEN.id);
      local.current = [GEMMA];
      // Every request to a removed model fails, the title request beside the turn included.
      stream.mockImplementation(async (request, emit) => {
        if (request.model === QWEN.id) throw new LocalModelRemovedError();
        emit({ type: 'content', text: 'hi', stopReason: 'end_turn' });
      });
      expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
      await vi.waitUntil(() => forgetLocal.mock.calls.length > 0 && !service.isSessionBusy(session.id), {
        interval: 5,
      });
      expect(listLocal).not.toHaveBeenCalled();

      expect(await service.send(session.id, 'again')).toMatchObject({
        ok: true,
        notice: expect.stringContaining('qwen2.5:0.5b is not available on this device'),
      });
      await vi.waitUntil(() => !service.isSessionBusy(session.id), { interval: 5 });
      expect(listLocal.mock.calls).toEqual([[true]]);
      expect((await store.get(session.id))?.model).toBe(GEMMA.id);
    });

    it('moves a placeholder conversation without a notice', async () => {
      const { service, local } = await fixture({ mode: 'device-local', local: [] });
      const session = await service.createSession();
      local.current = [QWEN];
      expect(await service.send(session.id, 'hello')).toEqual({ ok: true, messageId: expect.any(String) });
    });

    it('switches a deleted local model to the pick, with a notice', async () => {
      const { service, store, local, settled } = await fixture({ mode: 'device-local', local: [QWEN, GEMMA] });
      const session = await service.createSession();
      await service.setSessionModel(session.id, QWEN.id);
      local.current = [GEMMA];
      const result = await service.send(session.id, 'hello');
      expect(result).toMatchObject({
        ok: true,
        notice: expect.stringContaining('qwen2.5:0.5b is not available on this device'),
      });
      await settled(session.id);
      expect((await store.get(session.id))?.model).toBe(GEMMA.id);
    });
  });

  describe('the model a conversation settles on', () => {
    it('is the remembered pick when listed, for a new conversation, a send and settleSessionModel alike', async () => {
      const { service, store, local, record, settled } = await fixture({
        mode: 'device-local',
        local: [],
        remembered: QWEN.id,
      });
      const first = await service.createSession();
      const second = await service.createSession();
      local.current = [GEMMA, QWEN];

      const settledSummary = await service.settleSessionModel(first.id);
      expect(settledSummary?.session.model).toBe(QWEN.id);
      expect((await store.get(first.id))?.model).toBe(QWEN.id);
      expect(record).not.toHaveBeenCalled();

      await service.send(second.id, 'hello');
      await settled(second.id);
      expect((await store.get(second.id))?.model).toBe(QWEN.id);
      expect((await service.createSession()).model).toBe(QWEN.id);
    });

    it('keeps the live plan of a turn in flight on the settled summary', async () => {
      const { service, local } = await fixture({ mode: 'device-local', local: [] });
      const session = await service.createSession();
      local.current = [GEMMA];
      // livePlans is private; a turn in flight is the state under test, and its plan is all the overlay reads.
      const livePlans = (service as unknown as { livePlans: Map<string, unknown> }).livePlans;
      livePlans.set(session.id, { done: 1, total: 3, current: 'Step 2' });

      const settled = await service.settleSessionModel(session.id);
      expect(settled?.session.model).toBe(GEMMA.id);
      expect(settled?.session.plan).toEqual({ done: 1, total: 3, current: 'Step 2' });
    });

    it('is the first listed model with nothing remembered', async () => {
      const { service, local } = await fixture({ mode: 'device-local', local: [] });
      const session = await service.createSession();
      local.current = [GEMMA, QWEN];
      expect((await service.settleSessionModel(session.id))?.session.model).toBe(GEMMA.id);
    });

    it('changes nothing for a model that is already listed or when no list exists', async () => {
      const { service, local } = await fixture({ mode: 'device-local', local: [QWEN] });
      const session = await service.createSession();
      expect(await service.settleSessionModel(session.id)).toBeNull();
      local.current = [];
      expect(await service.settleSessionModel(session.id)).toBeNull();
    });
  });

  describe('an expired signed-in session', () => {
    it('keeps the Sign in refusal and never moves a hosted conversation onto a local model', async () => {
      const { service, store, stream, local } = await fixture({ mode: 'expired', local: [] });
      const session = await service.createSession();
      await service.setSessionModel(session.id, 'claude-opus-5');
      local.current = [QWEN];

      expect(await service.send(session.id, 'hello')).toEqual({ ok: false, error: 'Sign in to send a message.' });
      expect(await service.settleSessionModel(session.id)).toBeNull();
      expect((await store.get(session.id))?.model).toBe('claude-opus-5');
      expect((await store.get(session.id))?.messages).toEqual([]);
      expect(stream).not.toHaveBeenCalled();
    });
  });

  describe('signed-in chat', () => {
    it('keeps the hosted default with no models', async () => {
      const { service } = await fixture({ mode: 'signed-in', local: [] });
      expect((await service.createSession()).model).toBe(HOSTED_DEFAULT);
    });
  });

  describe('a conversation saved on a served-model alias', () => {
    const SERVER = 'srv-gpu';
    const ALIAS = localModelId(SERVER, 'qwen');
    const served = (tools: boolean): ChatModelOption => ({
      id: localModelId(SERVER, 'qwen-small'),
      name: 'qwen-small',
      backend: localBackend(SERVER),
      server: { id: 'gpu', name: 'GPU vLLM' },
      aliasIds: [ALIAS],
      ...(tools ? {} : { supportsTools: false }),
    });
    const turnTools = (stream: Awaited<ReturnType<typeof fixture>>['stream']) =>
      Math.max(...stream.mock.calls.map(([request]) => request.tools?.length ?? 0));

    it.each(['device-local', 'signed-in'] as const)(
      '%s: stays on the alias with the tools its primary entry has',
      async mode => {
        const { service, store, stream, listLocal, settled } = await fixture({
          mode,
          local: [GEMMA, served(true)],
          last: [GEMMA, served(true)],
        });
        const session = await service.createSession();
        await service.setSessionModel(session.id, ALIAS);
        expect(await service.settleSessionModel(session.id)).toBeNull();
        expect(await service.send(session.id, 'hello')).toEqual({ ok: true, messageId: expect.any(String) });
        await settled(session.id);
        expect((await store.get(session.id))?.model).toBe(ALIAS);
        expect(stream.mock.calls.every(([request]) => request.model === ALIAS)).toBe(true);
        expect(turnTools(stream)).toBeGreaterThan(0);
        expect(listLocal).not.toHaveBeenCalledWith(true);
      }
    );

    it.each([
      ['device-local', 1_024, true, false],
      ['signed-in', 1_024, true, false],
      ['device-local', 1_000_000, true, true],
      ['signed-in', 1_000_000, true, true],
      // Ollama grows its context to fit instead, so a window it reports is not a reason to drop tools.
      ['device-local', 1_024, false, true],
    ] as const)('%s: a %i-token context (fixed: %s) sends tools: %s', async (mode, window, fixed, withTools) => {
      const option = { ...served(true), contextWindow: window, ...(fixed ? { contextFixed: true } : {}) };
      const { service, stream, settled } = await fixture({ mode, local: [option], last: [option] });
      const session = await service.createSession();
      await service.setSessionModel(session.id, ALIAS);
      expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
      await settled(session.id);
      const sent = stream.mock.calls.find(([request]) => request.sessionId === session.id)?.[0];
      expect((sent?.tools?.length ?? 0) > 0).toBe(withTools);
      expect(sent?.toolPromptTokens === undefined).toBe(withTools);
      if (!withTools) expect(sent?.toolPromptTokens).toBeGreaterThan(0);
    });

    it.each([true, false])('marks a turn whose tools were withheld for no tool support (tools: %s)', async tools => {
      const { service, stream, settled } = await fixture({
        mode: 'device-local',
        local: [served(tools)],
        last: [served(tools)],
      });
      const session = await service.createSession();
      await service.setSessionModel(session.id, ALIAS);
      expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
      await settled(session.id);
      const sent = stream.mock.calls.find(([request]) => request.sessionId === session.id)?.[0];
      expect((sent?.tools?.length ?? 0) > 0).toBe(tools);
      expect(sent?.toolsUnsupported).toBe(tools ? undefined : true);
    });

    it('drops tools exactly when prompt, tools and the reply room pass the fixed window', () => {
      const wire = [
        { role: 'system' as const, content: 'You are Desktop. '.repeat(200) },
        { role: 'user' as const, content: 'Say hello.' },
      ];
      const tools = [
        { toolSchema: { name: 'read_file', description: 'Reads a file.', parameters: { type: 'object' } } },
      ];
      const at = (window: number, maxTokens?: number) =>
        toolPromptOverflow({ ...served(true), contextWindow: window, contextFixed: true }, wire, tools, maxTokens);
      const schemas = tools.map(tool => ({ type: 'function', function: tool.toolSchema }));
      const toolPrompt = estimateTokens(toMessages([wire[0]]), schemas);
      const prompt = estimateTokens(toMessages([wire[1]]));
      // The smallest window holding system prompt + tools + the user's prompt + min(reply, window / 4).
      let edge = 1;
      while (toolPrompt + prompt + Math.min(2_048, Math.floor(edge / 4)) > edge) edge++;
      expect(at(edge)).toBeUndefined();
      expect(at(edge - 1)).toBe(toolPrompt);
      expect(at(toolPrompt + prompt + 1, 1)).toBeUndefined();
      expect(at(toolPrompt + prompt, 1)).toBe(toolPrompt);
      expect(at(1_000_000)).toBeUndefined();
      expect(toolPromptOverflow({ ...served(true), contextWindow: 1 }, wire, tools, undefined)).toBeUndefined();
    });

    it('keeps tools that fit with the usual reply room when a max output override is larger', () => {
      const wire = [
        { role: 'system' as const, content: 'You are Desktop. '.repeat(2000) },
        { role: 'user' as const, content: 'Say hello.' },
      ];
      const tools = [
        { toolSchema: { name: 'read_file', description: 'Reads a file.', parameters: { type: 'object' } } },
      ];
      const schemas = tools.map(tool => ({ type: 'function', function: tool.toolSchema }));
      const window = estimateTokens(toMessages(wire), schemas) + 2_048;
      const option = { ...served(true), contextWindow: window, contextFixed: true };
      expect(Math.floor(window / 4)).toBeGreaterThan(2_048);
      expect(toolPromptOverflow(option, wire, tools, undefined)).toBeUndefined();
      expect(toolPromptOverflow(option, wire, tools, 16_384)).toBeUndefined();
      expect(toolPromptOverflow(option, wire, tools, 1)).toBeUndefined();
    });

    it.each(['device-local', 'signed-in'] as const)('%s: sends no tools when its primary has none', async mode => {
      const { service, stream, settled } = await fixture({ mode, local: [served(false)], last: [served(false)] });
      const session = await service.createSession();
      await service.setSessionModel(session.id, ALIAS);
      expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
      await settled(session.id);
      expect(stream.mock.calls.every(([request]) => request.model === ALIAS)).toBe(true);
      expect(turnTools(stream)).toBe(0);
    });
  });
});

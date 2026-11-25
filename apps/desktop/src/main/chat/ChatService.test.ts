import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type {
  ChatAutomaticOrigin,
  ChatSession,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatToolCall,
  EventCursor,
} from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { LocalHistory } from './LocalHistory';
import { AccessStore } from './tools/AccessStore';
import type { ModelCatalog } from './ModelCatalog';
import type { CompletionRequest } from './completions';
import type { CompletionStreamEvent } from './streamEvents';
import { ChatModels } from '@bike4mind/common';
import { summarizeSession } from '@shared/agentOutcome';
import { MessageQueue } from './MessageQueue';
import { ApprovalGate } from './tools/ApprovalGate';
import { SessionActivity } from './SessionActivity';
import { AttachmentStore } from './AttachmentStore';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function cursorOf(session: ChatSession | null): EventCursor {
  if (!session?.eventCursor) throw new Error('getSession returned no cursor');
  return session.eventCursor;
}

/** Waits for the next event of a given type, so tests never sleep on a fixed timeout. */
function waitFor(events: ChatStreamEvent[], type: ChatStreamEvent['type']): Promise<ChatStreamEvent> {
  return vi.waitUntil(() => events.find(event => event.type === type), { timeout: 2000, interval: 5 });
}

describe('ChatService', () => {
  let store: SessionStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let stream: PassThrough;
  let post: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let apiClient: AuthenticatedApiClient | null;

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-chat-')), 'test-model');
    // Bound per test: a previous service replying late must not push into this test's events.
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    stream = new PassThrough();
    const boundPost = vi.fn().mockResolvedValue({ data: stream, status: 200 });
    post = boundPost;
    get = vi.fn().mockResolvedValue({ sseCompletionsUrl: '' });

    apiClient = {
      get,
      getAxiosInstance: () => ({ post: boundPost }),
    } as unknown as AuthenticatedApiClient;

    service = new ChatService({
      store,
      // No granted roots, so no tools are declared - these cases exercise plain replies.
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
    });
  });

  it('streams a reply, then persists the settled turn', async () => {
    const { id } = await service.createSession();

    const accepted = await service.send(id, 'hello');
    expect(accepted).toMatchObject({ ok: true });

    await waitFor(events, 'start');
    stream.write(frame({ type: 'content', text: 'Hi ' }));
    stream.write(frame({ type: 'content', text: 'there', stopReason: 'end_turn', usage: { outputTokens: 2 } }));
    stream.write(frame('[DONE]'));

    const done = await waitFor(events, 'done');
    expect(done).toMatchObject({ content: 'Hi there', stopReason: 'end_turn', usage: { outputTokens: 2 } });
    expect(events.filter(event => event.type === 'delta').map(e => 'text' in e && e.text)).toEqual(['Hi ', 'there']);

    const session = await service.getSession(id);
    expect(session?.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi there'],
    ]);
    // The prompt names the thread, so the sidebar stops saying "New chat".
    expect(session?.title).toBe('hello');
  });

  it('completes a local turn while signed out and declares no tools for a plain model', async () => {
    const model = 'local:ollama:llama3.2';
    const localStore = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-local-chat-')), model);
    const localEvents: ChatStreamEvent[] = [];
    const local = {
      stream: vi.fn(async (request, emit) => {
        expect(request.tools).toEqual([]);
        expect(String(request.messages[0].content)).not.toMatch(
          /call request_directory|web_search|ask_user|todo_write/
        );
        emit({ type: 'content', text: 'Offline answer', stopReason: 'end_turn' });
      }),
    };
    const offline = new ChatService({
      store: localStore,
      access: { list: async () => [] } as unknown as AccessStore,
      models: {
        list: async () => ({
          models: [{ id: model, name: 'llama3.2', backend: 'local-ollama', supportsTools: false }],
        }),
        cached: () => [{ id: model, name: 'llama3.2', backend: 'local-ollama', supportsTools: false }],
      } as unknown as ModelCatalog,
      local: local as never,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => '',
      emit: event => localEvents.push(event),
    });
    const { id } = await offline.createSession();
    expect(await offline.send(id, 'answer offline')).toMatchObject({ ok: true });
    await waitFor(localEvents, 'done');
    expect((await offline.getSession(id))?.messages.at(-1)?.content).toBe('Offline answer');
  });

  it.each(['local:ollama:llama3.2', 'local:lmstudio:some-model'])(
    'keeps a local session on %s when the cached catalog lacks it',
    async model => {
      const localStore = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-local-reconcile-')), model);
      const localEvents: ChatStreamEvent[] = [];
      const local = {
        stream: vi.fn(async (_request, emit) => emit({ type: 'content', text: 'ok', stopReason: 'end_turn' })),
      };
      const hosted = [{ id: 'hosted-model', name: 'Hosted', backend: 'anthropic', supportsTools: true }];
      const service = new ChatService({
        store: localStore,
        access: { list: async () => [] } as unknown as AccessStore,
        models: { list: async () => ({ models: hosted }), cached: () => hosted } as unknown as ModelCatalog,
        local: local as never,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => null,
        getEnvironmentUrl: () => '',
        emit: event => localEvents.push(event),
      });
      const { id } = await service.createSession();
      await localStore.setModel(id, model);
      await service.send(id, 'still local');
      await waitFor(localEvents, 'done');
      expect(local.stream).toHaveBeenCalledWith(
        expect.objectContaining({ model }),
        expect.anything(),
        expect.anything()
      );
      expect((await service.getSession(id))?.model).toBe(model);
    }
  );

  it.each([false, true])(
    'keeps local naming, suggestions, compaction and Continue on device (signed in: %s)',
    async signedIn => {
      const model = 'local:ollama:llama3.2';
      const localStore = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-local-privacy-')), model);
      const localEvents: ChatStreamEvent[] = [];
      const option = { id: model, name: 'Local', supportsTools: false };
      const local = {
        stream: vi.fn(async (request: CompletionRequest, emit: (event: CompletionStreamEvent) => void) => {
          if (request.thinking === false) emit({ type: 'content', text: '<think>private reasoning</think>' });
          emit({ type: 'content', text: 'Useful local answer', stopReason: 'end_turn' });
        }),
      };
      const localService = new ChatService({
        store: localStore,
        access: { list: async () => [] } as unknown as AccessStore,
        models: {
          list: async () => ({ models: [option] }),
          listLocal: async () => [option],
          cached: () => [option],
        } as unknown as ModelCatalog,
        local: local as never,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => (signedIn ? apiClient : null),
        getEnvironmentUrl: () => '',
        emit: event => localEvents.push(event),
      });
      const { id } = await localService.createSession();
      expect(await localService.send(id, 'private prompt')).toMatchObject({ ok: true });
      await waitFor(localEvents, 'done');
      await vi.waitUntil(() => !localService.isSessionBusy(id), { interval: 5 });
      await vi.waitUntil(async () => (await localStore.get(id))?.title === 'Useful local answer', { interval: 5 });
      await localService.suggestNextPrompt(id, 'hosted-model');
      expect(await localService.compactContext(id)).toMatchObject({ ok: true });
      await localStore.appendMessage(id, {
        id: 'resume-me',
        role: 'assistant',
        content: 'Partial',
        createdAt: new Date().toISOString(),
        stopReason: 'tool_turn_limit',
      });
      expect(await localService.continueReply(id)).toMatchObject({ ok: true });
      await vi.waitUntil(() => !localService.isSessionBusy(id), { interval: 5 });
      expect(local.stream.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(local.stream.mock.calls.every(([request]) => request.model === model)).toBe(true);
      local.stream.mockRejectedValueOnce(new Error('local runtime disconnected'));
      expect(await localService.send(id, 'retry locally')).toMatchObject({ ok: true });
      await waitFor(localEvents, 'error');
      expect((await localStore.get(id))?.messages.at(-1)?.error).toContain('local runtime disconnected');
      expect(post).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    }
  );

  it('reports unavailable local history without changing the session opt-in', async () => {
    const { id } = await service.createSession();
    expect(() => service.searchHistory('anything')).toThrow('Local history is unavailable');
    await expect(service.setSessionHistory(id, true)).rejects.toThrow('Local history is unavailable');
    expect((await store.get(id))?.historyEnabled).not.toBe(true);
  });

  it('drops indexed history when it is switched off or the session is deleted', async () => {
    const history = {
      scopeKey: () => 'account-a',
      revision: () => 0,
      removeSession: vi.fn(),
      captureSession: vi.fn(),
      search: vi.fn(() => []),
    };
    const summaryChanged = vi.fn();
    const service = new ChatService({
      summaryChanged,
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      history: history as never,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => '',
      emit: () => undefined,
    });
    const { id } = await service.createSession();
    await service.setSessionHistory(id, true);
    expect(summaryChanged).toHaveBeenLastCalledWith(expect.objectContaining({ id, historyEnabled: true }));
    expect(history.captureSession).toHaveBeenCalledTimes(1);
    await service.setSessionHistory(id, false);
    expect(summaryChanged).toHaveBeenLastCalledWith(expect.objectContaining({ id }));
    expect(summaryChanged.mock.calls.at(-1)?.[0].historyEnabled).not.toBe(true);
    expect(history.removeSession).toHaveBeenCalledWith(id, 'account-a');
    history.removeSession.mockClear();
    await service.deleteSession(id);
    expect(history.removeSession).toHaveBeenCalledWith(id, 'account-a');
  });

  it('keeps the original history namespace through async turn acceptance and reply completion', async () => {
    let scope = 'account-a';
    const history = new LocalHistory(':memory:', () => scope);
    const scopedService = new ChatService({
      store,
      history,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
    const { id } = await scopedService.createSession();
    await scopedService.setSessionHistory(id, true);
    const get = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementationOnce(async sessionId => {
      const session = await get(sessionId);
      scope = 'account-b';
      return session;
    });
    expect(await scopedService.send(id, 'confidential lunar message')).toMatchObject({ ok: true });
    await waitFor(events, 'start');
    stream.write(frame({ type: 'content', text: 'confidential lunar answer', stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
    await waitFor(events, 'done');
    expect(history.state()).toEqual({ entries: 0 });
    expect(history.search('confidential')).toEqual([]);
    scope = 'account-a';
    expect(history.state()).toEqual({ entries: 1 });
    history.close();
  });

  it('restores the previous opt-in when explicit indexing fails', async () => {
    const history = new LocalHistory(':memory:');
    const indexedService = new ChatService({
      store,
      history,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
    const { id } = await indexedService.createSession();
    history.close();
    await expect(indexedService.setSessionHistory(id, true)).rejects.toThrow();
    expect((await store.get(id))?.historyEnabled).not.toBe(true);
  });

  it('does not duplicate or fail a persisted reply when background history indexing fails', async () => {
    const history = new LocalHistory(':memory:');
    const warn = vi.fn();
    const indexedService = new ChatService({
      store,
      history,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn },
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
    const { id } = await indexedService.createSession();
    await indexedService.setSessionHistory(id, true);
    history.close();
    await indexedService.send(id, 'hello');
    await waitFor(events, 'start');
    stream.write(frame({ type: 'content', text: 'one answer', stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
    await waitFor(events, 'done');
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect((await store.get(id))?.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not index conversation history'));
  });

  // A window opening a conversation mid-turn has only getSession to go on: replies are stored
  // when they settle, so without the live copy it showed the prompt alone until the end.
  it('includes the reply still streaming when a conversation is opened mid-turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hello');
    await waitFor(events, 'start');

    stream.write(frame({ type: 'content', text: 'Hi ' }));
    stream.write(frame({ type: 'content', text: 'the' }));
    await vi.waitUntil(() => events.filter(event => event.type === 'delta').length === 2, {
      timeout: 2000,
      interval: 5,
    });

    const midTurn = await service.getSession(id);
    expect(midTurn?.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi the'],
    ]);
    // With its turn's start, so the status line can show a true elapsed time.
    const start = events.find(event => event.type === 'start');
    expect(midTurn?.replyInFlight).toEqual({
      messageId: start && 'messageId' in start && start.messageId,
      startedAt: expect.any(Number),
    });

    stream.write(frame({ type: 'content', text: 're', stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
    await waitFor(events, 'done');

    // Stored once and not folded again on top of the stored copy.
    const settled = await service.getSession(id);
    expect(settled?.replyInFlight).toBeUndefined();
    expect(settled?.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi there'],
    ]);
  });

  describe('snapshot cursor', () => {
    it('numbers each event of a session in order and resumes from a mid-turn snapshot', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'hello');
      await waitFor(events, 'start');
      stream.write(frame({ type: 'content', text: 'Hi ' }));
      await vi.waitUntil(() => events.some(event => event.type === 'delta'), { timeout: 2000, interval: 5 });

      const midTurn = await service.getSession(id);
      const cursor = midTurn?.eventCursor;
      expect(cursor).toEqual({ epoch: expect.any(String), seq: events.at(-1)?.seq });

      stream.write(frame({ type: 'content', text: 'there', stopReason: 'end_turn' }));
      stream.write(frame('[DONE]'));
      await waitFor(events, 'done');

      const mine = events.filter(event => event.sessionId === id);
      expect(mine.map(event => event.seq)).toEqual(mine.map((_, index) => index + 1));
      const resumed = cursor && service.eventsSince(id, cursor);
      expect(resumed).toEqual({ ok: true, events: mine.filter(event => (event.seq ?? 0) > (cursor?.seq ?? 0)) });
      // The rest of the reply arrives exactly once on top of the snapshot.
      const text =
        midTurn?.messages.at(-1)?.content +
        (resumed?.ok ? resumed.events : []).map(event => (event.type === 'delta' ? event.text : '')).join('');
      expect(text).toBe('Hi there');

      const settled = await service.getSession(id);
      const last = events.filter(event => event.sessionId === id).at(-1);
      expect(settled?.eventCursor).toEqual({ epoch: cursor?.epoch, seq: last?.seq });
      expect(service.eventsSince(id, cursorOf(settled))).toEqual({ ok: true, events: [] });
    });

    it('starts the sequence over when the conversation is deleted', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'hello');
      await waitFor(events, 'start');
      const cursor = (await service.getSession(id))?.eventCursor;
      expect(cursor?.seq).toBeGreaterThan(0);
      await service.deleteSession(id);
      expect(service.eventsSince(id, cursor as EventCursor)).toEqual({ ok: false, reason: 'snapshot-required' });
    });

    it('hands out a cursor for a conversation with no turn yet', async () => {
      const { id } = await service.createSession();
      const opened = await service.getSession(id);
      expect(opened?.eventCursor).toEqual({ epoch: expect.any(String), seq: 0 });
    });

    // settleReply drops the live copy before its write lands, so a read in that gap sees neither
    // copy; the 'done' after the cursor must still hand the reply over, and only once.
    it('shows the reply once when the snapshot lands between dropping the live copy and storing it', async () => {
      const append = store.appendMessage.bind(store);
      let releaseWrite: () => void = () => {};
      const writeHeld = new Promise<void>(done => (releaseWrite = done));
      let reachedWrite = false;
      vi.spyOn(store, 'appendMessage').mockImplementation(async (sessionId, message) => {
        if (message.role === 'assistant') {
          reachedWrite = true;
          await writeHeld;
        }
        return append(sessionId, message);
      });
      const { id } = await service.createSession();
      await service.send(id, 'hello');
      await waitFor(events, 'start');
      stream.write(frame({ type: 'content', text: 'whole reply', stopReason: 'end_turn' }));
      stream.write(frame('[DONE]'));
      await vi.waitUntil(() => reachedWrite, { timeout: 2000, interval: 5 });

      const inGap = await service.getSession(id);
      expect(inGap?.replyInFlight).toBeUndefined();
      expect(inGap?.messages.map(message => message.role)).toEqual(['user']);

      releaseWrite();
      await waitFor(events, 'done');
      const resumed = service.eventsSince(id, cursorOf(inGap));
      const replies = resumed.ok ? resumed.events.filter(event => event.type === 'done') : [];
      expect(replies.map(event => event.type === 'done' && event.content)).toEqual(['whole reply']);
      expect(resumed.ok && resumed.events.filter(event => event.type === 'delta').map(event => event.seq)).toEqual([]);
    });

    // The settle write is queued when the read starts; the snapshot must include it, since its
    // cursor already counts the 'done' that follows.
    it('holds the settled reply in a snapshot read while its write is still queued', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'hello');
      await waitFor(events, 'start');
      stream.write(frame({ type: 'content', text: 'whole reply', stopReason: 'end_turn' }));
      stream.write(frame('[DONE]'));
      await waitFor(events, 'done');
      const done = events.filter(event => event.sessionId === id).at(-1);

      const write = store.appendMessage(id, {
        id: 'queued-reply',
        role: 'assistant',
        content: 'queued reply',
        createdAt: new Date().toISOString(),
      });
      const snapshot = service.getSession(id);
      await write;

      const read = await snapshot;
      expect(read?.messages.map(message => message.id)).toContain('queued-reply');
      expect(read?.eventCursor?.seq).toBe(done?.seq);
    });
  });

  // Opus 5 reasons on every turn, and the server inlines that into the text between markers.
  it('shows reasoning on its own and keeps it out of the reply and what is sent back', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitFor(events, 'start');
    stream.write(frame({ type: 'content', text: '<think>' }));
    stream.write(frame({ type: 'content', text: 'planning' }));
    stream.write(frame({ type: 'content', text: '</think>' }));
    stream.write(frame({ type: 'content', text: 'reply one' }));
    stream.write(frame('[DONE]'));
    await waitFor(events, 'done');

    expect(post.mock.calls[0][1].options.thinking).toEqual({ enabled: true });
    expect(events.filter(event => event.type === 'reasoning').map(e => 'text' in e && e.text)).toEqual(['planning']);
    expect(events.filter(event => event.type === 'delta').map(e => 'text' in e && e.text)).toEqual(['reply one']);
    const stored = (await service.getSession(id))?.messages.at(-1);
    expect(stored).toMatchObject({
      content: 'reply one',
      rounds: [{ text: 'reply one', toolCallIds: [], reasoning: 'planning' }],
    });

    stream = new PassThrough();
    post.mockResolvedValue({ data: stream, status: 200 });
    await service.send(id, 'second');
    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 2000, interval: 5 });
    expect(post.mock.calls[1][1].messages).toContainEqual({ role: 'assistant', content: 'reply one' });
  });

  it('resends the whole thread, because the endpoint keeps no conversation of its own', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitFor(events, 'start');
    stream.write(frame({ type: 'content', text: 'reply one' }));
    stream.write(frame('[DONE]'));
    await waitFor(events, 'done');

    stream = new PassThrough();
    post.mockResolvedValue({ data: stream, status: 200 });
    await service.send(id, 'second');
    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 2000, interval: 5 });

    // The leading system turn is the access preamble; the rest is the conversation itself.
    expect(post.mock.calls[1][1].messages.slice(1)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'second' },
    ]);
  });

  /**
   * Regression: with nothing granted the model used to receive no tools AND no statement about
   * access. In a thread whose earlier turns held a successful tool call it imitated that shape
   * and invented a filename and byte count instead of admitting it could not look.
   */
  it('tells the model it has no file access when nothing is granted', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'what is in my Downloads folder?');
    await vi.waitUntil(() => post.mock.calls.length === 1, { timeout: 2000, interval: 5 });

    const preamble = post.mock.calls[0][1].messages[0];
    expect(preamble.role).toBe('system');
    expect(preamble.content).toMatch(/NO access/);
    expect(preamble.content).toMatch(/never invent a file name/i);
    expect(preamble.content).toMatch(/call request_directory/);
    expect(preamble.content).toMatch(/Keep one with todo_write/);
    // Only the tools that read no files survive the missing grant: the plan, the server-side web
    // tools, the question, the request for a folder, which is how the conversation gets one, and the loop.
    expect(post.mock.calls[0][1].options.tools).toEqual([
      expect.objectContaining({ toolSchema: expect.objectContaining({ name: 'todo_write' }) }),
      expect.objectContaining({ toolSchema: expect.objectContaining({ name: 'web_search' }) }),
      expect.objectContaining({ toolSchema: expect.objectContaining({ name: 'web_fetch' }) }),
      expect.objectContaining({ toolSchema: expect.objectContaining({ name: 'ask_user' }) }),
      expect.objectContaining({ toolSchema: expect.objectContaining({ name: 'request_directory' }) }),
      expect.objectContaining({ toolSchema: expect.objectContaining({ name: 'loop' }) }),
    ]);
  });

  it('keeps the partial reply when stopped, reported as done rather than an error', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'go');
    await waitFor(events, 'start');

    stream.write(frame({ type: 'content', text: 'half' }));
    await vi.waitUntil(() => events.some(event => event.type === 'delta'), { timeout: 2000, interval: 5 });
    service.stop(id);

    const done = await waitFor(events, 'done');
    expect(done).toMatchObject({ content: 'half', stopReason: 'aborted' });
    expect((await service.getSession(id))?.messages[1]).toMatchObject({ content: 'half', stopReason: 'aborted' });
  });

  it('persists a failed turn so the thread explains itself on reopen', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'go');
    await waitFor(events, 'start');
    stream.write(frame({ type: 'error', message: 'insufficient credits' }));

    const failure = await waitFor(events, 'error');
    expect(failure).toMatchObject({ message: 'insufficient credits' });
    expect((await service.getSession(id))?.messages[1]).toMatchObject({ error: 'insufficient credits' });
  });

  it('refuses a send while the same conversation is still replying', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitFor(events, 'start');
    // 'start' is emitted before the request goes out, so wait for the request itself: the
    // assertion below is about a SECOND one never being made, which says nothing if the first
    // has not been made either.
    await vi.waitUntil(() => post.mock.calls.length === 1, { timeout: 2000, interval: 5 });

    expect(await service.send(id, 'second')).toMatchObject({ ok: false });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refuses a send when there is no session, without touching the thread', async () => {
    const { id } = await service.createSession();
    apiClient = null;

    expect(await service.send(id, 'hello')).toMatchObject({ ok: false, error: expect.stringMatching(/Sign in/) });
    expect((await service.getSession(id))?.messages).toEqual([]);
  });

  it.each([' ', ''])('refuses a blank prompt (%j)', async text => {
    const { id } = await service.createSession();
    expect(await service.send(id, text)).toMatchObject({ ok: false });
  });

  it('refuses a send to a deleted conversation', async () => {
    const { id } = await service.createSession();
    await service.deleteSession(id);
    expect(await service.send(id, 'hello')).toMatchObject({ ok: false });
  });

  it('prefers the advertised self-host endpoint and looks it up only once per environment', async () => {
    get.mockResolvedValue({ sseCompletionsUrl: 'http://localhost:8788/api/ai/v1/completions' });

    const { id } = await service.createSession();
    await service.send(id, 'one');
    await waitFor(events, 'start');
    stream.write(frame('[DONE]'));
    await waitFor(events, 'done');

    stream = new PassThrough();
    post.mockResolvedValue({ data: stream, status: 200 });
    await service.send(id, 'two');
    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 2000, interval: 5 });

    expect(post.mock.calls[0][0]).toBe('http://localhost:8788/api/ai/v1/completions');
    expect(post.mock.calls[1][0]).toBe('http://localhost:8788/api/ai/v1/completions');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('falls back to the same-origin path when serverConfig cannot be read', async () => {
    get.mockRejectedValue(new Error('offline'));

    const { id } = await service.createSession();
    await service.send(id, 'one');
    // The POST, not the 'start' event: 'start' fires before the endpoint is resolved.
    await vi.waitUntil(() => post.mock.calls.length === 1, { timeout: 2000, interval: 5 });

    expect(post.mock.calls[0][0]).toBe('/api/ai/v1/completions');
  });
});

describe('phase', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  describe('ChatService model phase', () => {
    let streams: PassThrough[];
    let events: ChatStreamEvent[];
    let debug: ReturnType<typeof vi.fn<(message: string) => void>>;

    async function serviceWith(turnTiming: boolean): Promise<ChatService> {
      // Bound to this test's sinks: a previous service replying late must not write into the next test's.
      const emitted = events;
      const opened = streams;
      const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-timing-')));
      const post = vi.fn().mockImplementation(() => {
        const stream = new PassThrough();
        opened.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      });
      return new ChatService({
        store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-timing-sessions-')), 'test-model'),
        models: {
          list: async () => ({ models: [{ id: 'test-model', name: 'Test', backend: 'openai' }] }),
          cached: () => [],
        } as unknown as ModelCatalog,
        access: { list: async () => [root] } as unknown as AccessStore,
        logger: { debug, warn: vi.fn() },
        turnTiming,
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: event => emitted.push(event),
      });
    }

    async function runTurn(service: ChatService, frames: unknown[]): Promise<void> {
      const { id } = await service.createSession();
      await service.send(id, 'go');
      await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
      for (const payload of frames) streams[0].write(frame(payload));
      streams[0].write(frame('[DONE]'));
      await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    }

    beforeEach(() => {
      streams = [];
      events = [];
      debug = vi.fn<(message: string) => void>();
    });

    const phases = () => events.flatMap(event => (event.type === 'phase' ? [event.phase] : []));

    it('reports each phase of a round once, in the order the stream shows it', async () => {
      const service = await serviceWith(false);
      await runTurn(service, [
        { type: 'content', text: '<think>' },
        { type: 'content', text: '</think>' },
        { type: 'content', text: 'Updating ' },
        { type: 'content', text: 'the file.' },
        { type: 'content', text: '', toolStarted: { name: 'file_write', id: 'c1' } },
      ]);

      expect(phases()).toEqual([
        { kind: 'waiting' },
        { kind: 'thinking' },
        { kind: 'responding' },
        { kind: 'writing-tool', name: 'file_write' },
      ]);
    });

    it('announces a call to any tool, not only the ones that write files', async () => {
      const service = await serviceWith(false);
      await runTurn(service, [{ type: 'content', text: '', toolStarted: { name: 'grep_search' } }]);

      expect(phases()).toContainEqual({ kind: 'writing-tool', name: 'grep_search' });
    });
  });
});

describe('timing', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  describe('ChatService round timing', () => {
    let streams: PassThrough[];
    let events: ChatStreamEvent[];
    let debug: ReturnType<typeof vi.fn<(message: string) => void>>;

    async function serviceWith(turnTiming: boolean): Promise<ChatService> {
      // Bound to this test's sinks: a previous service replying late must not write into the next test's.
      const emitted = events;
      const opened = streams;
      const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-timing-')));
      const post = vi.fn().mockImplementation(() => {
        const stream = new PassThrough();
        opened.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      });
      return new ChatService({
        store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-timing-sessions-')), 'test-model'),
        models: {
          list: async () => ({ models: [{ id: 'test-model', name: 'Test', backend: 'openai' }] }),
          cached: () => [],
        } as unknown as ModelCatalog,
        access: { list: async () => [root] } as unknown as AccessStore,
        logger: { debug, warn: vi.fn() },
        turnTiming,
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: event => emitted.push(event),
      });
    }

    async function runTurn(service: ChatService, frames: unknown[]): Promise<void> {
      const { id } = await service.createSession();
      await service.send(id, 'go');
      await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
      for (const payload of frames) streams[0].write(frame(payload));
      streams[0].write(frame('[DONE]'));
      await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    }

    const timingLines = () =>
      debug.mock.calls
        .map(([line]) => line)
        .filter(line => line.startsWith('CHAT_TIMING '))
        .map(line => JSON.parse(line.slice('CHAT_TIMING '.length)) as Record<string, unknown>);

    beforeEach(() => {
      streams = [];
      events = [];
      debug = vi.fn<(message: string) => void>();
    });

    it('records an empty thinking block as markers, not reasoning', async () => {
      const service = await serviceWith(true);
      await runTurn(service, [
        { type: 'meta', requestId: 'r1' },
        { type: 'content', text: '<think>' },
        { type: 'content', text: '</think>' },
        { type: 'content', text: 'hello' },
      ]);

      const [round] = timingLines();
      expect(round).toMatchObject({ model: 'test-model', round: 0, frames: 4 });
      expect(round.firstMetaMs).toEqual(expect.any(Number));
      expect(round.firstMarkerMs).toEqual(expect.any(Number));
      expect(round.firstTextMs).toEqual(expect.any(Number));
      expect(round.firstReasoningMs).toBeUndefined();
      expect(round.beforeSendMs).toEqual(expect.any(Number));
    });

    it('counts text the think filter holds back as a possible marker as text', async () => {
      const service = await serviceWith(true);
      await runTurn(service, [
        { type: 'content', text: '<' },
        { type: 'content', text: 'b>bold' },
      ]);

      const [round] = timingLines();
      expect(round.firstMarkerMs).toBeUndefined();
      expect(round).toMatchObject({ frames: 2, firstTextMs: expect.any(Number) });
    });

    it('logs nothing when timing is off', async () => {
      const service = await serviceWith(false);
      await runTurn(service, [{ type: 'content', text: 'hello' }]);

      expect(timingLines()).toEqual([]);
    });
  });
});

describe('pruning', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  interface WireBlock {
    type?: string;
    tool_use_id?: string;
    content?: unknown;
  }

  interface WireMessage {
    role: string;
    content: string | WireBlock[];
  }

  describe('ChatService stale tool results', () => {
    let service: ChatService;
    let events: ChatStreamEvent[];
    let streams: PassThrough[];
    /** Each request's messages as serialized when it was sent; the live wire keeps growing after. */
    let sent: string[];
    let root: string;
    let store: SessionStore;

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-prune-')));
      // About 25K characters each: two of them pass the batch floor, one does not.
      const body = `${Array.from({ length: 250 }, (_, n) => `line ${n} ${'y'.repeat(90)}`).join('\n')}\n`;
      await writeFile(join(root, 'a.ts'), body, 'utf8');
      await writeFile(join(root, 'b.ts'), body, 'utf8');

      store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-prune-sessions-')), 'test-model');
      // Bound per test: a previous service replying late must not push into this test's events.
      const emitted: ChatStreamEvent[] = [];
      events = emitted;
      const opened: PassThrough[] = [];
      streams = opened;
      sent = [];
      const post = vi.fn().mockImplementation((_url: string, body: { messages: unknown[] }) => {
        sent.push(JSON.stringify(body.messages));
        const stream = new PassThrough();
        opened.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      });

      service = new ChatService({
        store,
        access: { list: async () => [root] } as unknown as AccessStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: event => emitted.push(event),
      });
    });

    async function reply(index: number, payload: unknown): Promise<void> {
      await vi.waitUntil(() => streams.length === index + 1, { timeout: 3000, interval: 5 });
      streams[index].write(frame(payload));
      streams[index].write(frame('[DONE]'));
    }

    function readBoth(prefix: string, input: Record<string, unknown> = {}): unknown {
      return {
        type: 'tool_use',
        tools: ['a.ts', 'b.ts'].map(name => ({
          id: `${prefix}_${name}`,
          name: 'file_read',
          arguments: JSON.stringify({ path: join(root, name), ...input }),
        })),
      };
    }

    function messages(index: number): WireMessage[] {
      return JSON.parse(sent[index]) as WireMessage[];
    }

    function resultFor(wire: WireMessage[], id: string): unknown {
      for (const message of wire) {
        if (!Array.isArray(message.content)) continue;
        const block = message.content.find(entry => entry.type === 'tool_result' && entry.tool_use_id === id);
        if (block) return block.content;
      }
      return undefined;
    }

    it('keeps the wire prefix stable until a batch fires, then keeps the placeholders on later turns', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'look at both files');

      await reply(0, readBoth('r0'));
      // Same range under different arguments, so the loop does not read it as a repeated round.
      await reply(1, readBoth('r1', { offset: 1, limit: 5000 }));
      await reply(2, { type: 'tool_use', tools: [{ id: 'g2', name: 'glob_files', arguments: '{"pattern":"*"}' }] });
      await reply(3, { type: 'content', text: 'Both files look fine.' });
      await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });

      // Round 2's request is round 1's plus the new pair: nothing earlier moved.
      const round1 = messages(1);
      const round2 = messages(2);
      expect(round2).toHaveLength(round1.length + 2);
      expect(JSON.stringify(round2.slice(0, round1.length))).toBe(JSON.stringify(round1));

      // Before round 3, the round-0 reads are no longer exempt and together pass the floor.
      const round3 = messages(3);
      const placeholder = `[stale: ${join(root, 'a.ts')} was read here; the file was rewritten or re-read later. Read it again if you need it.]`;
      expect(resultFor(round3, 'r0_a.ts')).toBe(placeholder);
      expect(resultFor(round3, 'r0_b.ts')).toMatch(/^\[stale: .*b\.ts was read here;/);
      expect(resultFor(round3, 'r1_a.ts')).toMatch(/^ *1\tline 0 /);
      expect(resultFor(round2, 'r0_a.ts')).toMatch(/^ *1\tline 0 /);

      const stored = (await service.getSession(id))?.messages[1];
      const cleared = stored?.toolCalls?.filter(call => call.cleared).map(call => call.id);
      expect(cleared).toEqual(['r0_a.ts', 'r0_b.ts']);
      expect(stored?.toolCalls?.find(call => call.id === 'r0_a.ts')?.preview).toMatch(/^ *1\tline 0 /);

      await service.send(id, 'and now?');
      await reply(4, { type: 'content', text: 'Still fine.' });
      const nextTurn = messages(4);
      expect(resultFor(nextTurn, 'r0_a.ts')).toBe(placeholder);
      expect(resultFor(nextTurn, 'r0_b.ts')).toBe(resultFor(round3, 'r0_b.ts'));
    });

    it('sends a single stale read untouched while the tally is under the floor', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'look at a');

      const readA = (callId: string, input: Record<string, unknown> = {}) => ({
        type: 'tool_use',
        tools: [{ id: callId, name: 'file_read', arguments: JSON.stringify({ path: join(root, 'a.ts'), ...input }) }],
      });
      await reply(0, readA('first'));
      await reply(1, readA('second', { limit: 5000 }));
      await reply(2, { type: 'tool_use', tools: [{ id: 'g', name: 'glob_files', arguments: '{"pattern":"*"}' }] });
      await reply(3, { type: 'content', text: 'ok' });
      await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });

      const round2 = messages(2);
      const round3 = messages(3);
      expect(JSON.stringify(round3.slice(0, round2.length))).toBe(JSON.stringify(round2));
      expect(resultFor(round3, 'first')).toMatch(/^ *1\tline 0 /);
    });
  });
});

describe('livePlan', () => {
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
});

describe('autoFix', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  function toolTurn(id: string, name: string, input: Record<string, unknown>): string {
    return frame({ type: 'tool_use', tools: [{ id, name, arguments: JSON.stringify(input) }] });
  }

  const origin: ChatAutomaticOrigin = {
    kind: 'auto-fix',
    prUrl: 'https://github.com/example-org/widgets/pull/611',
    prNumber: 611,
    summary: '1 failing check on #611',
  };

  describe('ChatService automatic turns', () => {
    let store: SessionStore;
    let service: ChatService;
    let events: ChatStreamEvent[];
    let streams: PassThrough[];
    let root: string;

    const ended = (): ChatToolCall[] => events.flatMap(event => (event.type === 'tool-end' ? [event.call] : []));

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-autofix-')));
      store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-autofix-sessions-')), 'test-model');
      const testEvents: ChatStreamEvent[] = [];
      const testStreams: PassThrough[] = [];
      const post = vi.fn().mockImplementation(() => {
        const stream = new PassThrough();
        testStreams.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      });
      events = testEvents;
      streams = testStreams;
      service = new ChatService({
        store,
        queue: new MessageQueue(() => undefined),
        access: { list: async () => [root] } as unknown as AccessStore,
        approvals: new ApprovalGate(),
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: event => testEvents.push(event),
      });
    });

    afterEach(() => {
      service.dispose();
      for (const stream of streams) stream.end();
    });

    it('marks the turn as started by auto-fix, not by the user', async () => {
      const session = await service.createSession();
      expect(await service.startAutomaticTurn(session.id, 'fix the build', origin)).toEqual({ ok: true });
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });

      const messages = (await store.get(session.id))?.messages ?? [];
      expect(messages[0]).toMatchObject({ role: 'user', system: true, automatic: origin, content: 'fix the build' });
    });

    it('refuses to start while a turn is running', async () => {
      const session = await service.createSession();
      await service.send(session.id, 'go');
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      expect(await service.startAutomaticTurn(session.id, 'fix the build', origin)).toMatchObject({
        ok: false,
        busy: true,
      });
    });

    it('refuses to start while a send is still being accepted', async () => {
      const session = await service.createSession();
      const typed = service.send(session.id, 'mine');
      expect(await service.startAutomaticTurn(session.id, 'fix the build', origin)).toMatchObject({
        ok: false,
        busy: true,
      });
      await typed;
    });

    it('denies a force-push inside an auto-fix turn', async () => {
      const session = await service.createSession();
      await service.setApprovalMode(session.id, 'auto');
      await service.startAutomaticTurn(session.id, 'fix the build', origin);
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      streams[0].write(toolTurn('c1', 'bash_execute', { command: 'git push --force', cwd: root }));
      streams[0].write(frame('[DONE]'));

      const denied = await vi.waitUntil(() => ended().find(call => call.status === 'denied'), {
        timeout: 5000,
        interval: 10,
      });
      expect(denied.error).toContain('may not force-push');
    });
  });
});

describe('sessionClosed', () => {
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
});

describe('import-delete', () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'import-delete-'));
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const store = new SessionStore(join(root, 'sessions'), 'model');
    const attachments = new AttachmentStore(join(root, 'attachments'), logger);
    const sessionId = 'cc-imported';
    const added = await attachments.add(sessionId, [
      { source: 'bytes', name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('keep these bytes') },
    ]);
    await store.putImported({
      id: sessionId,
      title: 'Imported',
      model: 'model',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      mode: 'chat',
      approvalMode: 'ask',
      reasoningEffort: 'default',
      importOrigin: { kind: 'claude-code', sourceId: 'original', importedAt: 'x', sourceUpdatedAt: 'x' },
      messages: [{ id: 'cc-original', role: 'user', content: 'hello', createdAt: 'x', attachments: added.attachments }],
    });
    const service = new ChatService({
      store,
      attachments,
      access: new AccessStore(join(root, 'access.json')),
      logger,
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => {},
    });
    return { store, service, attachments, sessionId, attachmentId: added.attachments[0].id };
  }

  describe('ChatService imported session removal', () => {
    it('keeps attachments when the atomic guard finds a continued conversation', async () => {
      const { store, service, attachments, sessionId, attachmentId } = await setup();
      await store.appendMessage(sessionId, { id: 'my-turn', role: 'user', content: 'continued', createdAt: 'x' });
      expect(await service.deleteImportedSession(sessionId, 'scope')).toBe('forked');
      expect(await store.get(sessionId)).not.toBeNull();
      expect((await attachments.read(sessionId, attachmentId))?.toString()).toBe('keep these bytes');
    });

    it('cleans attachments after the atomic guard removes an imported conversation', async () => {
      const { store, service, attachments, sessionId, attachmentId } = await setup();
      expect(await service.deleteImportedSession(sessionId, 'scope')).toBe('removed');
      expect(await store.get(sessionId)).toBeNull();
      expect(await attachments.read(sessionId, attachmentId)).toBeNull();
    });
  });
});

describe('pullRequest', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  describe('ChatService set_session_pull_request', () => {
    let service: ChatService;
    let events: ChatStreamEvent[];
    let streams: PassThrough[];
    let post: ReturnType<typeof vi.fn>;
    let project: string;
    const bindForAgent = vi.fn();
    const dismiss = vi.fn();

    beforeEach(async () => {
      project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-pr-tool-')));
      const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-pr-tool-sessions-')), 'test-model');
      const emitted: ChatStreamEvent[] = [];
      events = emitted;
      const opened: PassThrough[] = [];
      streams = opened;
      bindForAgent.mockReset().mockImplementation(async () => ({
        ok: true,
        pr: {
          owner: 'example-org',
          repo: 'widgets',
          number: 700,
          url: 'https://github.com/example-org/widgets/pull/700',
        },
      }));
      dismiss.mockReset().mockResolvedValue({ ok: true });
      const boundPost = vi.fn().mockImplementation(() => {
        const stream = new PassThrough();
        opened.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      });
      post = boundPost;
      service = new ChatService({
        store,
        access: { list: async () => [] } as unknown as AccessStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
        pullRequests: { bindForAgent, dismiss },
        queue: new MessageQueue(() => undefined),
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post: boundPost }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: event => emitted.push(event),
      });
    });

    afterEach(() => {
      service.dispose();
      for (const stream of streams) stream.end();
    });

    const declared = (request: number): string[] =>
      (post.mock.calls[request][1].options.tools as { toolSchema: { name: string } }[]).map(
        entry => entry.toolSchema.name
      );

    it('is declared to a Code session and not to a Chat session', async () => {
      const chat = await service.createSession();
      await service.send(chat.id, 'hello');
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      expect(declared(0)).not.toContain('set_session_pull_request');

      const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
      if (!created.ok) throw new Error(created.error);
      await service.send(created.session.id, 'hello');
      await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
      expect(declared(1)).toContain('set_session_pull_request');
    });

    it('binds for the calling session only, without asking', async () => {
      const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
      if (!created.ok) throw new Error(created.error);
      const { id } = created.session;
      await service.send(id, 'the PR for this session is #700');
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      streams[0].write(
        frame({
          type: 'tool_use',
          tools: [{ id: 't1', name: 'set_session_pull_request', arguments: JSON.stringify({ pull_request: '#700' }) }],
        })
      );
      streams[0].write(frame('[DONE]'));

      const end = await vi.waitUntil(
        () => events.find(event => event.type === 'tool-end' && event.call.name === 'set_session_pull_request'),
        { timeout: 5000, interval: 5 }
      );
      expect(bindForAgent).toHaveBeenCalledWith(id, '#700');
      expect(end).toMatchObject({
        call: { status: 'done', label: "Set the session's PR to example-org/widgets#700" },
      });
      expect(events.some(event => event.type === 'tool-start' && event.call.approvalId)).toBe(false);
    });

    it('is declared in, but refused by, a turn the user did not type', async () => {
      const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
      if (!created.ok) throw new Error(created.error);
      const { id } = created.session;
      const started = await service.startAutomaticTurn(id, 'the build finished', {
        kind: 'background-exit',
        processIds: ['aaaa1111'],
        summary: 'build exited 0',
      });
      expect(started).toEqual({ ok: true });
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      expect(declared(0)).toContain('set_session_pull_request');

      streams[0].write(
        frame({
          type: 'tool_use',
          tools: [{ id: 't1', name: 'set_session_pull_request', arguments: JSON.stringify({ clear: true }) }],
        })
      );
      streams[0].write(frame('[DONE]'));
      const end = await vi.waitUntil(
        () => events.find(event => event.type === 'tool-end' && event.call.name === 'set_session_pull_request'),
        { timeout: 5000, interval: 5 }
      );
      expect(JSON.stringify(end)).toContain('The PR bar can only be changed in a turn the user typed.');
      expect(dismiss).not.toHaveBeenCalled();
      expect(bindForAgent).not.toHaveBeenCalled();
    });
  });
});

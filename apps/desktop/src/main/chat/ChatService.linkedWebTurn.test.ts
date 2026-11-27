import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatSession, ChatStreamEvent } from '@shared/chat';
import { LINKED_RUNNING_LEASE_MS } from '@shared/webLinkedChat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { AttachmentStore } from './AttachmentStore';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

const frame = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

const SESSION_ID = 'bw-scope-nb1';

function webChat(overrides: Partial<ChatSession['importOrigin'] & object> = {}): ChatSession {
  return {
    id: SESSION_ID,
    title: 'Notebook',
    model: 'claude-sonnet',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    importOrigin: {
      kind: 'b4m-web',
      sourceId: 'nb1',
      importedAt: '2026-01-01T00:00:00.000Z',
      sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
    messages: [
      { id: 'bw-q0-p', role: 'user', content: 'earlier', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'bw-q0-r', role: 'assistant', content: 'answer', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
}

describe('ChatService linked web turns', () => {
  let store: SessionStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let queue: MessageQueue;
  let stopReplyAnswer: () => Promise<unknown>;
  const turnPosts = () => post.mock.calls.filter(call => !String(call[0]).includes('stop-reply'));
  const stopPosts = () => post.mock.calls.filter(call => String(call[0]).includes('stop-reply'));

  const streamFor = (index: number) => {
    streams[index] ??= new PassThrough();
    return streams[index];
  };
  const waitForEvent = (type: ChatStreamEvent['type']) =>
    vi.waitUntil(() => events.some(event => event.type === type), { timeout: 2000, interval: 5 });
  const waitForPost = (count = 1) => vi.waitUntil(() => turnPosts().length >= count, { timeout: 2000, interval: 5 });

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-linked-')), 'test-model');
    events = [];
    const emitted = events;
    streams = [];
    stopReplyAnswer = async () => ({ data: { status: 'cancelled', questId: 'q1' }, status: 200 });
    let streamCount = 0;
    const boundPost = vi
      .fn()
      .mockImplementation((url: string) =>
        url.includes('stop-reply')
          ? stopReplyAnswer()
          : Promise.resolve({ data: streamFor(streamCount++), status: 200 })
      );
    post = boundPost;
    const apiClient = {
      get: vi.fn().mockResolvedValue({ sseCompletionsUrl: '' }),
      getAxiosInstance: () => ({ post: boundPost }),
    } as unknown as AuthenticatedApiClient;
    service = new ChatService({
      store,
      attachments: new AttachmentStore(await mkdtemp(join(tmpdir(), 'b4m-linked-att-')), {
        debug: vi.fn(),
        warn: vi.fn(),
      }),
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      queue: (queue = new MessageQueue(() => undefined)),
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
    });
    await store.putImported(webChat());
  });

  /** Sends and serves the turn's `turn` frame, which is what the send resolves on. */
  const sendLinked = async (text = 'new question') => {
    const sent = service.send(SESSION_ID, text);
    await waitForPost();
    streamFor(0).write(frame({ type: 'meta', requestId: 'r1' }));
    streamFor(0).write(frame({ type: 'turn', quest_id: 'q1', session_id: 'nb1' }));
    return sent;
  };

  it('sends the turn to the web session and stores it under the importer ids, unforked', async () => {
    const result = await sendLinked();
    expect(result).toEqual({ ok: true, messageId: 'bw-q1-r' });
    expect(post).toHaveBeenCalledWith(
      '/api/v1/turns',
      expect.objectContaining({ session_id: 'nb1', message: 'new question', model: 'claude-sonnet' }),
      expect.objectContaining({ responseType: 'stream' })
    );

    streamFor(0).write(frame({ type: 'delta', quest_id: 'q1', slot: 0, text: 'Hel' }));
    streamFor(0).write(frame({ type: 'delta', quest_id: 'q1', slot: 0, text: 'lo' }));
    streamFor(0).write(frame({ type: 'settled', quest_id: 'q1', status: 'done', failed: false }));
    streamFor(0).write(frame('[DONE]'));
    await waitForEvent('done');

    expect(events.filter(event => event.type === 'delta').map(event => (event as { text: string }).text)).toEqual([
      'Hel',
      'lo',
    ]);
    expect(events.find(event => event.type === 'done')).toMatchObject({ messageId: 'bw-q1-r', content: 'Hello' });
    const stored = await store.get(SESSION_ID);
    expect(stored?.messages.map(message => [message.id, message.content])).toEqual([
      ['bw-q0-p', 'earlier'],
      ['bw-q0-r', 'answer'],
      ['bw-q1-p', 'new question'],
      ['bw-q1-r', 'Hello'],
    ]);
    expect(stored?.importOrigin?.forkedAt).toBeUndefined();
  });

  it('replaces a reply a sync brought in mid-turn instead of adding a second one', async () => {
    await sendLinked();
    const synced = webChat();
    synced.messages.push(
      { id: 'bw-q1-p', role: 'user', content: 'new question', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'bw-q1-r', role: 'assistant', content: 'Hel', createdAt: '2026-01-01T00:00:00.000Z' }
    );
    expect(await store.putImported(synced)).toBe('written');
    streamFor(0).write(frame({ type: 'delta', quest_id: 'q1', slot: 0, text: 'Hello' }));
    streamFor(0).write(frame('[DONE]'));
    await waitForEvent('done');

    const stored = await store.get(SESSION_ID);
    expect(stored?.messages.filter(message => message.id === 'bw-q1-r')).toHaveLength(1);
    expect(stored?.messages.at(-1)?.content).toBe('Hello');
  });

  it('shows a failed settle as an error on the reply, without forking', async () => {
    await sendLinked();
    streamFor(0).write(frame({ type: 'delta', quest_id: 'q1', slot: 0, text: 'Your plan does not allow this model.' }));
    streamFor(0).write(frame({ type: 'settled', quest_id: 'q1', status: 'done', failed: true }));
    streamFor(0).write(frame('[DONE]'));
    await waitForEvent('error');

    expect(events.find(event => event.type === 'error')).toMatchObject({
      messageId: 'bw-q1-r',
      message: 'Your plan does not allow this model.',
    });
    const stored = await store.get(SESSION_ID);
    expect(stored?.messages.at(-1)).toMatchObject({ id: 'bw-q1-r', error: 'Your plan does not allow this model.' });
    expect(stored?.importOrigin?.forkedAt).toBeUndefined();
  });

  it('shows an error frame on the reply with the server message', async () => {
    await sendLinked();
    streamFor(0).write(frame({ type: 'error', message: 'Provider overloaded' }));
    await waitForEvent('error');

    expect(events.find(event => event.type === 'error')).toMatchObject({
      messageId: 'bw-q1-r',
      message: 'Provider overloaded',
    });
    expect((await store.get(SESSION_ID))?.importOrigin?.forkedAt).toBeUndefined();
  });

  it('resolves a pre-stream refusal as a failed send and stores nothing', async () => {
    post.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: { status: 400, data: JSON.stringify({ message: 'Unknown model' }) },
      })
    );
    const result = await service.send(SESSION_ID, 'new question');

    expect(result).toEqual({ ok: false, error: 'Unknown model (status 400)' });
    expect(events).toEqual([]);
    const stored = await store.get(SESSION_ID);
    expect(stored?.messages).toHaveLength(2);
    expect(stored?.importOrigin?.forkedAt).toBeUndefined();
  });

  it('refuses a second send while the linked turn runs, rather than queueing it', async () => {
    await sendLinked();
    const second = await service.send(SESSION_ID, 'typed ahead');

    expect(second).toMatchObject({ ok: false, busy: true });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refuses a send while a reply in the notebook is still running on the web', async () => {
    await store.putImported(webChat({ runningSince: new Date().toISOString() }));
    const result = await service.send(SESSION_ID, 'new question');

    expect(result).toMatchObject({ ok: false, busy: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('sends again once a running mark nothing renewed has lapsed', async () => {
    await store.putImported(webChat({ runningSince: new Date(Date.now() - LINKED_RUNNING_LEASE_MS).toISOString() }));

    expect(await sendLinked()).toEqual({ ok: true, messageId: 'bw-q1-r' });
  });

  it('clears the running mark once its own turn settles', async () => {
    await sendLinked();
    const synced = webChat({ runningSince: new Date().toISOString() });
    await store.putImported(synced);
    streamFor(0).write(frame('[DONE]'));
    await waitForEvent('done');

    expect((await store.get(SESSION_ID))?.importOrigin?.runningSince).toBeUndefined();
  });

  it('keeps the chat busy when the stream ends before the turn settles', async () => {
    await sendLinked();
    streamFor(0).write(frame({ type: 'delta', quest_id: 'q1', slot: 0, text: 'Hel' }));
    streamFor(0).end();
    await waitForEvent('error');

    expect(events.find(event => event.type === 'error')).toMatchObject({
      messageId: 'bw-q1-r',
      message: expect.stringContaining('dropped before the reply finished'),
    });
    const stored = await store.get(SESSION_ID);
    expect(stored?.messages.at(-1)).toMatchObject({ id: 'bw-q1-r', content: 'Hel' });
    expect(stored?.importOrigin?.runningSince).toBeDefined();
  });

  it('keeps the POST open on a Stop before the turn is named, then stops that quest', async () => {
    const sent = service.send(SESSION_ID, 'new question');
    await waitForPost();
    service.stop(SESSION_ID);
    // The route creates the quest before it answers, so cancelling the POST would orphan it.
    expect((turnPosts()[0]?.[2] as { signal: AbortSignal }).signal.aborted).toBe(false);
    streamFor(0).write(frame({ type: 'turn', quest_id: 'q1', session_id: 'nb1' }));
    await waitForEvent('done');

    expect(await sent).toMatchObject({ ok: true });
    expect(stopPosts()).toEqual([['/api/sessions/nb1/chat/stop-reply', { questId: 'q1' }]]);
    const stored = await store.get(SESSION_ID);
    expect(stored?.messages.at(-1)).toMatchObject({ id: 'bw-q1-r', stopReason: 'aborted' });
    expect(stored?.importOrigin?.runningSince).toBeUndefined();
  });

  it('sends a message queued during the turn once the turn completes', async () => {
    await sendLinked();
    queue.enqueueRelay(SESSION_ID, 'relayed in', { fromSessionId: 'other', fromTitle: 'Other', hops: 1 });
    streamFor(0).write(frame({ type: 'delta', quest_id: 'q1', slot: 0, text: 'Hello' }));
    streamFor(0).write(frame('[DONE]'));

    await waitForPost(2);
    // A relay is automated, so it takes the local path rather than a second server turn.
    expect(turnPosts()[1]?.[0]).not.toBe('/api/v1/turns');
    expect(queue.list(SESSION_ID)).toHaveLength(0);
  });

  it('stops the server turn on Stop and frees the chat once the server confirms', async () => {
    await sendLinked();
    service.stop(SESSION_ID);
    await waitForEvent('done');

    expect(stopPosts()).toEqual([['/api/sessions/nb1/chat/stop-reply', { questId: 'q1' }]]);
    const stored = await store.get(SESSION_ID);
    expect(stored?.messages.at(-1)).toMatchObject({ id: 'bw-q1-r', stopReason: 'aborted' });
    expect(stored?.importOrigin?.runningSince).toBeUndefined();
  });

  it('keeps the chat busy after Stop when the server does not confirm the stop', async () => {
    stopReplyAnswer = () => Promise.reject(new Error('Network Error'));
    await sendLinked();
    service.stop(SESSION_ID);
    await waitForEvent('done');

    expect((await store.get(SESSION_ID))?.importOrigin?.runningSince).toBeDefined();
    const next = await service.send(SESSION_ID, 'next question');
    expect(next).toMatchObject({ ok: false, busy: true });
    expect(turnPosts()).toHaveLength(1);
  });

  it('still forks on the local paths: an edit rewinds the thread and marks it continued', async () => {
    const result = await service.send(SESSION_ID, 'edited', [], { replaces: 'bw-q0-p' });
    expect(result).toMatchObject({ ok: true });
    expect(post.mock.calls[0]?.[0]).not.toBe('/api/v1/turns');
    expect((await store.get(SESSION_ID))?.importOrigin?.forkedAt).toBeDefined();
  });
});

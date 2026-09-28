import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
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
    events = [];
    stream = new PassThrough();
    post = vi.fn().mockResolvedValue({ data: stream, status: 200 });
    get = vi.fn().mockResolvedValue({ sseCompletionsUrl: '' });

    apiClient = {
      get,
      getAxiosInstance: () => ({ post }),
    } as unknown as AuthenticatedApiClient;

    service = new ChatService({
      store,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
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

    expect(post.mock.calls[1][1].messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'second' },
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
    await waitFor(events, 'start');

    expect(post.mock.calls[0][0]).toBe('/api/ai/v1/completions');
  });
});

import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatQueueEvent, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * session_send, and above all the bound that stops two sessions talking to each other forever.
 *
 * The spawn caps do not help here: a spawn tree is acyclic and both of them read off it, while
 * messaging makes the graph cyclic and leaves no parent to terminate the exchange. So the first
 * test drives two sessions that BOTH ask to message the other on every single turn - a
 * deliberate ping-pong - and the property being proved is that it stops on its own.
 *
 * No approval gate is wired in, deliberately, exactly as in the spawn caps: the gate would stop
 * the exchange by itself, and a test that passes because the user was asked proves nothing
 * about the bound underneath it.
 */
describe('ChatService session_send', () => {
  let store: SessionStore;
  let service: ChatService;
  let queue: MessageQueue;
  let events: ChatStreamEvent[];
  let queueEvents: ChatQueueEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let project: string;

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-relay-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-relay-sessions-')), 'test-model');
    // Each test's service writes into arrays captured HERE rather than reached through the
    // bindings below. dispose() stops a service streaming, but a turn it had already started can
    // still run a continuation afterwards, and that continuation would otherwise open a stream
    // into the NEXT test's array - where the next test would answer it against the wrong store.
    const ownEvents: ChatStreamEvent[] = [];
    const ownQueueEvents: ChatQueueEvent[] = [];
    const ownStreams: PassThrough[] = [];
    const ownPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      ownStreams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    events = ownEvents;
    queueEvents = ownQueueEvents;
    streams = ownStreams;
    post = ownPost;

    queue = new MessageQueue(event => ownQueueEvents.push(event));
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      queue,
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: ownPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => ownEvents.push(event),
    });
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
  });

  async function codeSession(title: string): Promise<ChatSessionSummary> {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    // Fixed titles so a relay's own framing never collides with the markers below, and so the
    // rows under test name something a reader recognises.
    const named = await store.rename(created.session.id, title);
    return named ?? created.session;
  }

  function requestSend(stream: PassThrough, targetId: string, message: string, id: string): void {
    stream.write(
      frame({
        type: 'tool_use',
        tools: [{ id, name: 'session_send', arguments: JSON.stringify({ session_id: targetId, message }) }],
      })
    );
    stream.write(frame('[DONE]'));
  }

  function endTurn(stream: PassThrough, text = 'nothing more to do'): void {
    stream.write(frame({ type: 'content', text, stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
  }

  /** The thread this request carries, as the wire has it: index 0 is the access preamble. */
  function messagesOf(index: number): { role: string; content: unknown }[] {
    return (post.mock.calls[index]?.[1]?.messages ?? []) as { role: string; content: unknown }[];
  }

  /**
   * Whether this request opens a NEW turn rather than carrying one on.
   *
   * A continuation round ends on the tool_result block the previous round produced, which is an
   * array; a fresh turn ends on the message that started it, whose content is a string.
   */
  function isFreshTurn(index: number): boolean {
    const messages = messagesOf(index);
    return typeof messages[messages.length - 1]?.content === 'string';
  }

  /** Every settled call of a tool, in the order they finished. */
  function settledCalls(name: string) {
    return events
      .filter(event => event.type === 'tool-end')
      .map(event => (event.type === 'tool-end' ? event.call : null))
      .filter(call => call?.name === name);
  }

  const awaitStream = (index: number, timeout = 5000) =>
    vi.waitUntil(() => streams.length > index, { timeout, interval: 5 });

  it('stops two sessions messaging each other back and forth, without either of them agreeing to', async () => {
    const alpha = await codeSession('Alpha');
    const beta = await codeSession('Beta');

    // Index 1 is always the first thread message, so this marker identifies Alpha's own turns
    // however long its history grows; every other session's index 1 is a relayed message.
    await service.send(alpha.id, 'kick off');

    // Answer every request as it opens - a fresh turn always asks to message the other session,
    // a continuation round just finishes - until nothing new opens. If the bound did not hold,
    // this would keep finding work and fail on the round limit rather than hanging.
    let opened = 0;
    for (; opened < 40; opened++) {
      try {
        await awaitStream(opened, 1500);
      } catch {
        break;
      }
      if (!isFreshTurn(opened)) {
        endTurn(streams[opened]);
        continue;
      }
      const isAlpha = String(messagesOf(opened)[1]?.content).includes('kick off');
      requestSend(streams[opened], isAlpha ? beta.id : alpha.id, `ping ${opened}`, `send-${opened}`);
    }
    expect(opened).toBeLessThan(40);

    const calls = settledCalls('session_send');
    const delivered = calls.filter(call => call?.status === 'done');
    const refused = calls.filter(call => call?.status === 'error');

    // Three messages get through - one per hop - and the fourth attempt is refused. The chain is
    // bounded by the hop count each message carries, so it terminates whichever way the two
    // sessions arrange it.
    expect(delivered).toHaveLength(3);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error).toMatch(/hops from the user/);

    // The exchange really is over rather than merely slow: nothing further opened.
    const settled = streams.length;
    await expect(awaitStream(settled, 1000)).rejects.toThrow();
  });

  it('caps how many messages one turn may send, so a single turn cannot fan out across the project', async () => {
    const sender = await codeSession('Sender');
    const one = await codeSession('One');
    const two = await codeSession('Two');
    const three = await codeSession('Three');

    await service.send(sender.id, 'tell everyone');
    await awaitStream(0);

    // Three at once, the way a model asks for parallel tools: the count is reserved before the
    // first await, so a check made against a value read earlier would let all three through.
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [one, two, three].map((target, index) => ({
          id: `fan-${index}`,
          name: 'session_send',
          arguments: JSON.stringify({ session_id: target.id, message: `work item ${index}` }),
        })),
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => settledCalls('session_send').length === 3, { timeout: 5000, interval: 5 });
    const calls = settledCalls('session_send');
    expect(calls.filter(call => call?.status === 'done')).toHaveLength(2);
    const refused = calls.filter(call => call?.status === 'error');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error).toMatch(/may send 2 messages/);
  });

  it('runs the message straight away in a session that is idle', async () => {
    const sender = await codeSession('Sender');
    const target = await codeSession('Target');

    await service.send(sender.id, 'go');
    await awaitStream(0);
    requestSend(streams[0], target.id, 'have a look at the config', 'send-idle');

    await vi.waitUntil(() => settledCalls('session_send').length === 1, { timeout: 5000, interval: 5 });
    const call = settledCalls('session_send')[0];
    expect(call?.status).toBe('done');
    expect(call?.preview).toMatch(/running your message now/);
    expect(call?.label).toBe('Messaged @Target: have a look at the config');

    // Waited for rather than read straight off, because sending is fire and forget BY DESIGN:
    // the tool settles as soon as the message is queued, and the target's own turn - which is
    // what writes this - starts on a later tick that nothing here awaits. Reading immediately
    // asserted on whichever side of that gap the machine happened to land on.
    await vi.waitUntil(async () => ((await store.get(target.id))?.messages.length ?? 0) > 0, {
      timeout: 5000,
      interval: 10,
    });

    // It reached the target as a message of its own, marked as a relay rather than as the user.
    const stored = await store.get(target.id);
    expect(stored?.messages[0]).toMatchObject({
      role: 'user',
      system: true,
      content: 'have a look at the config',
      relay: { fromSessionId: sender.id, fromTitle: 'Sender', hops: 1 },
    });

    // A turn really opened for it, carrying the framing that says who it is from.
    await vi.waitUntil(
      () =>
        post.mock.calls.some(call => JSON.stringify(call[1]?.messages).includes('Message from another conversation')),
      { timeout: 5000, interval: 5 }
    );
  });

  it('queues the message behind a reply that is already running, and runs it when that one ends', async () => {
    const sender = await codeSession('Sender');
    const target = await codeSession('Target');

    // The target is mid-reply before anything is sent to it.
    await service.send(target.id, 'a question the user asked');
    await awaitStream(0);

    await service.send(sender.id, 'go');
    await awaitStream(1);
    requestSend(streams[1], target.id, 'one more thing', 'send-busy');

    await vi.waitUntil(() => settledCalls('session_send').length === 1, { timeout: 5000, interval: 5 });
    expect(settledCalls('session_send')[0]?.status).toBe('done');
    expect(settledCalls('session_send')[0]?.preview).toMatch(/runs as its next turn/);
    expect(queue.list(target.id)).toHaveLength(1);
    expect(queue.list(target.id)[0]?.relay).toMatchObject({ fromTitle: 'Sender', hops: 1 });

    // Nothing has been written into the target yet: it is still answering the user.
    expect((await store.get(target.id))?.messages).toHaveLength(1);

    endTurn(streams[0], 'answered the user');

    await vi.waitUntil(async () => ((await store.get(target.id))?.messages.length ?? 0) >= 3, {
      timeout: 5000,
      interval: 10,
    });
    const messages = (await store.get(target.id))?.messages ?? [];
    expect(messages[2]).toMatchObject({ system: true, content: 'one more thing' });
    expect(queue.list(target.id)).toHaveLength(0);
  });

  it('fails cleanly when the target has been deleted, archived, or is the caller itself', async () => {
    const sender = await codeSession('Sender');
    const gone = await codeSession('Gone');
    const archived = await codeSession('Archived');

    await service.deleteSession(gone.id);
    await service.setSessionArchived(archived.id, true);

    await service.send(sender.id, 'go');
    await awaitStream(0);
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [
          { id: 'x-gone', name: 'session_send', arguments: JSON.stringify({ session_id: gone.id, message: 'hello' }) },
          {
            id: 'x-archived',
            name: 'session_send',
            arguments: JSON.stringify({ session_id: archived.id, message: 'hello' }),
          },
          { id: 'x-self', name: 'session_send', arguments: JSON.stringify({ session_id: sender.id, message: 'hi' }) },
        ],
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => settledCalls('session_send').length === 3, { timeout: 5000, interval: 5 });
    const byId = new Map(settledCalls('session_send').map(call => [call?.id, call]));

    // Every one is an ordinary failed tool result the model can act on - nothing thrown, nothing
    // half-delivered, and no turn started anywhere.
    expect(byId.get('x-gone')?.status).toBe('error');
    expect(byId.get('x-gone')?.error).toMatch(/No conversation with that id/);
    expect(byId.get('x-archived')?.status).toBe('error');
    expect(byId.get('x-archived')?.error).toMatch(/is archived/);
    expect(byId.get('x-self')?.status).toBe('error');
    expect(byId.get('x-self')?.error).toMatch(/this conversation/);
    expect(queue.list(archived.id)).toHaveLength(0);
  });

  it('keeps a relayed message in the target transcript when its turn never runs', async () => {
    const sender = await codeSession('Sender');
    const target = await codeSession('Target');

    await service.send(target.id, 'a question the user asked');
    await awaitStream(0);

    await service.send(sender.id, 'go');
    await awaitStream(1);
    requestSend(streams[1], target.id, 'do not lose this', 'send-stopped');
    await vi.waitUntil(() => queue.list(target.id).length === 1, { timeout: 5000, interval: 5 });

    // The user stops the reply the message was waiting behind. Their OWN queued text would go
    // back to the composer here; another session's words must not, so it lands in the thread.
    service.stop(target.id);

    await vi.waitUntil(async () => ((await store.get(target.id))?.messages.length ?? 0) >= 3, {
      timeout: 5000,
      interval: 10,
    });
    const messages = (await store.get(target.id))?.messages ?? [];
    expect(messages[messages.length - 1]).toMatchObject({
      system: true,
      content: 'do not lose this',
      relay: { fromTitle: 'Sender' },
    });

    // And it was never offered to the composer.
    const returned = queueEvents.flatMap(event => event.returned?.messages ?? []);
    expect(returned).toHaveLength(0);
  });

  it('declares session_send to a Code session, with no argument that could widen what it reaches', async () => {
    const sender = await codeSession('Sender');
    await service.send(sender.id, 'go');
    await awaitStream(0);

    const declared = post.mock.calls[0][1].options.tools as { toolSchema: { name: string; parameters: object } }[];
    const schema = declared.find(entry => entry.toolSchema.name === 'session_send');
    expect(Object.keys((schema?.toolSchema.parameters as { properties: object }).properties)).toEqual([
      'session_id',
      'message',
    ]);
  });
});

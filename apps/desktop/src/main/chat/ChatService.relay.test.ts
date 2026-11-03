import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatQueueEvent, ChatRelayOrigin, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { formatSessionMention } from '@shared/sessionMention';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionActivity } from './SessionActivity';
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
  let activity: SessionActivity;

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
    activity = new SessionActivity(() => undefined);
    service = new ChatService({
      store,
      activity,
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

  async function codeSession(title: string, directory = project): Promise<ChatSessionSummary> {
    const created = await service.createCodeSession({ directory, branch: '', workspace: false });
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

    // Five messages get through - one per hop - and the sixth attempt is refused. The chain is
    // bounded by the hop count each message carries, so it terminates whichever way the two
    // sessions arrange it.
    expect(delivered).toHaveLength(5);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error).toMatch(/hops from the user/);

    // The exchange really is over rather than merely slow: nothing further opened.
    const settled = streams.length;
    await expect(awaitStream(settled, 1000)).rejects.toThrow();
  });

  it('stops two busy sessions relaying to each other mid-turn', async () => {
    const alpha = await codeSession('Alpha');
    const beta = await codeSession('Beta');
    await service.send(alpha.id, 'kick off alpha');
    await service.send(beta.id, 'kick off beta');

    // Every request that ends on a kick-off or a relay answers by messaging the other session and
    // carrying on with a tool step, so both stay busy and each relay lands at a round boundary.
    let opened = 0;
    let midTurn = 0;
    for (; opened < 60; opened++) {
      try {
        await awaitStream(opened, 1500);
      } catch {
        break;
      }
      const messages = messagesOf(opened);
      const last = JSON.stringify(messages.at(-1)?.content ?? '');
      if (!last.includes('kick off') && !last.includes('[Message from another conversation')) {
        endTurn(streams[opened]);
        continue;
      }
      if (!isFreshTurn(opened)) midTurn++;
      const isAlpha = String(messages[1]?.content).includes('kick off alpha');
      requestSend(streams[opened], isAlpha ? beta.id : alpha.id, `ping ${opened}`, `send-${opened}`);
    }
    expect(opened).toBeLessThan(60);
    expect(midTurn).toBeGreaterThan(0);

    // Two chains, one per kick-off, each held to five hops however the relays land.
    const calls = settledCalls('session_send');
    expect(calls.filter(call => call?.status === 'done')).toHaveLength(10);
    const refused = calls.filter(call => call?.status === 'error');
    expect(refused).toHaveLength(2);
    for (const call of refused) expect(call?.error).toMatch(/hops from the user/);

    const settled = streams.length;
    await expect(awaitStream(settled, 1000)).rejects.toThrow();
  });

  it('ends a chain of notify_when_done messages at the hop bound, landing the last notice without a turn', async () => {
    const alpha = await codeSession('Alpha');
    const beta = await codeSession('Beta');
    await service.send(alpha.id, 'kick off');

    let opened = 0;
    for (; opened < 60; opened++) {
      try {
        await awaitStream(opened, 1500);
      } catch {
        break;
      }
      const last = JSON.stringify(messagesOf(opened).at(-1)?.content ?? '');
      if (!isFreshTurn(opened) || last.includes('finished the turn your message started')) {
        endTurn(streams[opened]);
        continue;
      }
      const isAlpha = String(messagesOf(opened)[1]?.content).includes('kick off');
      streams[opened].write(
        frame({
          type: 'tool_use',
          tools: [
            {
              id: `send-${opened}`,
              name: 'session_send',
              arguments: JSON.stringify({
                session_id: isAlpha ? beta.id : alpha.id,
                message: `ping ${opened}`,
                notify_when_done: true,
              }),
            },
          ],
        })
      );
      streams[opened].write(frame('[DONE]'));
    }
    expect(opened).toBeLessThan(60);

    const settledStreams = streams.length;
    await expect(awaitStream(settledStreams, 1000)).rejects.toThrow();

    const stored = [...((await store.get(alpha.id))?.messages ?? []), ...((await store.get(beta.id))?.messages ?? [])];
    const notices = stored.filter(message => /finished the turn your message started/.test(message.content));
    expect(notices.some(message => message.relay?.kind === 'done')).toBe(true);
    expect(notices.some(message => !message.relay)).toBe(true);
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

  describe('delivered into a running turn', () => {
    const askForTool = (stream: PassThrough, id: string) => {
      stream.write(frame({ type: 'tool_use', tools: [{ id, name: 'no_such_tool', arguments: '{}' }] }));
      stream.write(frame('[DONE]'));
    };
    const streamCarrying = (text: string) =>
      streams.findIndex((_, index) => JSON.stringify(messagesOf(index).at(-1) ?? '').includes(text));

    it.each(['same boundary', 'later boundary'])(
      'never lowers the hop limit for a shallower relay at the %s',
      async boundary => {
        const target = await codeSession('Target');
        const other = await codeSession('Other');
        await service.send(target.id, 'a long task');
        await awaitStream(0);
        const origin = { fromSessionId: other.id, fromTitle: 'Other' };
        queue.enqueueRelay(target.id, 'deep relay', { ...origin, hops: 5 });
        if (boundary === 'same boundary') queue.enqueueRelay(target.id, 'shallow relay', { ...origin, hops: 1 });
        askForTool(streams[0], 'step-1');
        await awaitStream(1);
        if (boundary === 'later boundary') {
          queue.enqueueRelay(target.id, 'shallow relay', { ...origin, hops: 1 });
          askForTool(streams[1], 'step-2');
          await awaitStream(2);
        }
        requestSend(streams.at(-1)!, other.id, 'must not send', 'send-capped');

        await vi.waitUntil(() => settledCalls('session_send').length === 1);
        expect(settledCalls('session_send')[0]).toMatchObject({
          status: 'error',
          error: expect.stringMatching(/5 hops from the user/),
        });
        expect(queue.list(other.id)).toEqual([]);
        expect((await store.get(other.id))?.messages).toEqual([]);
      }
    );

    it('holds a mid-turn relay to the same hop limit as a turn of its own', async () => {
      const sender = await codeSession('Sender');
      const target = await codeSession('Target');
      const other = await codeSession('Other');

      await service.send(target.id, 'a long task');
      await awaitStream(0);
      queue.enqueueRelay(target.id, 'pass this on', { fromSessionId: sender.id, fromTitle: 'Sender', hops: 5 });
      askForTool(streams[0], 'step-1');

      await awaitStream(1);
      expect(streamCarrying('pass this on')).toBe(1);
      requestSend(streams[1], other.id, 'passing it on', 'send-capped');

      await vi.waitUntil(() => settledCalls('session_send').length === 1, { timeout: 5000, interval: 5 });
      expect(settledCalls('session_send')[0]?.status).toBe('error');
      expect(settledCalls('session_send')[0]?.error).toMatch(/5 hops from the user/);
      expect(queue.list(other.id)).toHaveLength(0);
      expect((await store.get(other.id))?.messages ?? []).toHaveLength(0);
    });

    it('carries the turn on at the relay depth with the send budget its own turn would start with', async () => {
      const sender = await codeSession('Sender');
      const target = await codeSession('Target');
      const other = await codeSession('Other');

      await service.send(target.id, 'a long task');
      await awaitStream(0);
      // Both of this turn's sends spent at hop 0, then a relay at hop 1 arrives behind them.
      streams[0].write(
        frame({
          type: 'tool_use',
          tools: ['first', 'second'].map(message => ({
            id: `spend-${message}`,
            name: 'session_send',
            arguments: JSON.stringify({ session_id: other.id, message }),
          })),
        })
      );
      queue.enqueueRelay(target.id, 'one more thing', { fromSessionId: sender.id, fromTitle: 'Sender', hops: 1 });
      streams[0].write(frame('[DONE]'));

      await vi.waitUntil(() => streamCarrying('one more thing') >= 0, { timeout: 5000, interval: 5 });
      const continuing = streams[streamCarrying('one more thing')];
      continuing.write(
        frame({
          type: 'tool_use',
          tools: ['third', 'fourth', 'fifth'].map(message => ({
            id: `send-after-relay-${message}`,
            name: 'session_send',
            arguments: JSON.stringify({ session_id: other.id, message }),
          })),
        })
      );
      continuing.write(frame('[DONE]'));

      await vi.waitUntil(() => settledCalls('session_send').length === 5, { timeout: 5000, interval: 5 });
      expect(settledCalls('session_send').filter(call => call?.status === 'done')).toHaveLength(4);
      expect(settledCalls('session_send').filter(call => call?.status === 'error')[0]?.error).toMatch(
        /may send 2 messages/
      );
      // Parallel tools can finish in either order; the successful calls determine which messages arrived.
      const sentAfterRelay = settledCalls('session_send')
        .filter(call => call?.status === 'done' && call.id.startsWith('send-after-relay-'))
        .map(call => call?.input.message);
      expect(sentAfterRelay).toHaveLength(2);
      expect(queue.list(other.id).map(entry => entry.relay?.hops)).toEqual([1, 2, 2]);
      expect(
        queue
          .list(other.id)
          .slice(1)
          .map(entry => entry.text)
          .sort()
      ).toEqual(sentAfterRelay.sort());
    });
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
    expect(settledCalls('session_send')[0]?.preview).toMatch(/once its current step finishes/);
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

  it('runs two messages sent to one idle session one turn at a time', async () => {
    const sender = await codeSession('Sender');
    const target = await codeSession('Target');
    const started = vi.spyOn(activity, 'replyStarted');
    const ended = vi.spyOn(activity, 'replyEnded');

    await service.send(sender.id, 'go');
    await awaitStream(0);
    // Both in one round, so they run in parallel: the second reaches the target while the first
    // is still being accepted there, before any reply exists to mark it busy.
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: ['first relay', 'second relay'].map((message, index) => ({
          id: `pair-${index}`,
          name: 'session_send',
          arguments: JSON.stringify({ session_id: target.id, message }),
        })),
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => settledCalls('session_send').length === 2, { timeout: 5000, interval: 5 });
    expect(settledCalls('session_send').every(call => call?.status === 'done')).toBe(true);

    const turnFor = (text: string) =>
      streams.findIndex((_, index) => {
        const messages = messagesOf(index);
        return JSON.stringify(messages[messages.length - 1]?.content ?? '').includes(text);
      });
    await vi.waitUntil(() => turnFor('first relay') >= 0 || turnFor('second relay') >= 0, {
      timeout: 5000,
      interval: 5,
    });
    const firstText = turnFor('first relay') >= 0 ? 'first relay' : 'second relay';
    const secondText = firstText === 'first relay' ? 'second relay' : 'first relay';

    // Long enough for a racing second accept to have opened its own request.
    await new Promise(done => setTimeout(done, 200));
    expect(turnFor(secondText)).toBe(-1);
    expect(started.mock.calls.filter(([id]) => id === target.id)).toHaveLength(1);
    expect(queue.list(target.id)).toHaveLength(1);

    endTurn(streams[turnFor(firstText)], 'handled the first');
    await vi.waitUntil(() => turnFor(secondText) >= 0, { timeout: 5000, interval: 5 });
    await vi.waitUntil(() => ended.mock.calls.filter(([id]) => id === target.id).length === 1, {
      timeout: 5000,
      interval: 5,
    });
    expect(started.mock.calls.filter(([id]) => id === target.id)).toHaveLength(2);

    // Stop reaches the turn that is actually running, and its end is reported too.
    service.stop(target.id);
    await vi.waitUntil(() => ended.mock.calls.filter(([id]) => id === target.id).length === 2, {
      timeout: 5000,
      interval: 5,
    });
    expect(service.isSessionBusy(target.id)).toBe(false);
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
    expect(byId.get('x-gone')?.error).toMatch(/No conversation matches/);
    expect(byId.get('x-archived')?.status).toBe('error');
    expect(byId.get('x-archived')?.error).toMatch(/is archived/);
    expect(byId.get('x-self')?.status).toBe('error');
    expect(byId.get('x-self')?.error).toMatch(/this conversation/);
    expect(queue.list(archived.id)).toHaveLength(0);
  });

  it('tells a sender that asked to be notified when its message never runs', async () => {
    const sender = await codeSession('Sender');
    const target = await codeSession('Target');

    await service.send(target.id, 'a question the user asked');
    await awaitStream(0);
    await service.send(sender.id, 'go');
    await awaitStream(1);
    streams[1].write(
      frame({
        type: 'tool_use',
        tools: [
          {
            id: 'n-stranded',
            name: 'session_send',
            arguments: JSON.stringify({ session_id: target.id, message: 'run later', notify_when_done: true }),
          },
        ],
      })
    );
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => queue.list(target.id).length === 1, { timeout: 5000, interval: 5 });

    service.stop(target.id);

    await vi.waitUntil(
      async () =>
        JSON.stringify(queue.list(sender.id)).includes('did not run your message') ||
        JSON.stringify(post.mock.calls).includes('did not run your message') ||
        ((await store.get(sender.id))?.messages ?? []).some(message =>
          /did not run your message/.test(message.content)
        ),
      { timeout: 5000, interval: 10 }
    );
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
    // notify_when_done only asks for a turn back here; nothing in it says where a message may go.
    expect(Object.keys((schema?.toolSchema.parameters as { properties: object }).properties)).toEqual([
      'session_id',
      'notify_when_done',
      'message',
    ]);
  });

  describe('across projects', () => {
    let other: string;

    beforeEach(async () => {
      other = await realpath(await mkdtemp(join(tmpdir(), 'b4m-relay-other-')));
    });

    function callTools(stream: PassThrough, calls: { id: string; name: string; input: object }[]): void {
      stream.write(
        frame({
          type: 'tool_use',
          tools: calls.map(call => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.input) })),
        })
      );
      stream.write(frame('[DONE]'));
    }

    /** The first request whose last message is a string matching `pattern`: a fresh turn about it. */
    async function turnAbout(pattern: RegExp): Promise<number> {
      const find = () =>
        post.mock.calls.findIndex((_call, index) => {
          const messages = messagesOf(index);
          const last = messages[messages.length - 1]?.content;
          return typeof last === 'string' && pattern.test(last);
        });
      await vi.waitUntil(() => find() >= 0, { timeout: 5000, interval: 5 });
      return find();
    }

    const callById = (id: string) =>
      ['session_send', 'session_read', 'session_list'].flatMap(settledCalls).find(call => call?.id === id);

    it('holds a message to another project until its user lets it in, then runs it there', async () => {
      const sender = await codeSession('Sender');
      const target = await codeSession('Elsewhere', other);

      await service.send(sender.id, 'go');
      await awaitStream(0);
      requestSend(streams[0], target.id, 'please rebase onto main', 'h1');
      await vi.waitUntil(() => !!callById('h1'), { timeout: 5000, interval: 5 });

      expect(callById('h1')?.error).toBeUndefined();
      expect(callById('h1')?.preview).toMatch(/waiting for that conversation's/);
      const held = service.heldRelaysFor(target.id);
      expect(held).toHaveLength(1);
      expect(held[0].reason).toBe('other-project');
      expect(held[0].relay.fromProject).toBe(basename(project));
      expect(events.some(event => event.type === 'held-relays' && event.sessionId === target.id)).toBe(true);
      expect(queue.list(target.id)).toHaveLength(0);
      expect(service.isSessionBusy(target.id)).toBe(false);

      await service.resolveHeldRelay(target.id, held[0].id, true);
      const index = await turnAbout(/please rebase onto main/);
      const framed = messagesOf(index).at(-1)?.content as string;
      expect(framed).toContain(`in the project "${basename(project)}"`);
      expect(framed).toContain(`session_send with session_id ${sender.id}`);
      expect(service.heldRelaysFor(target.id)).toHaveLength(0);
    });

    it('tells the sender when the receiving user declines, and runs nothing there', async () => {
      const sender = await codeSession('Sender');
      const target = await codeSession('Elsewhere', other);

      await service.send(sender.id, 'go');
      await awaitStream(0);
      requestSend(streams[0], target.id, 'delete the build folder', 'd1');
      await vi.waitUntil(() => service.heldRelaysFor(target.id).length === 1, { timeout: 5000, interval: 5 });
      await awaitStream(1);
      endTurn(streams[1]);
      await vi.waitUntil(() => !service.isSessionBusy(sender.id), { timeout: 5000, interval: 5 });
      const requests = post.mock.calls.length;

      await service.resolveHeldRelay(target.id, service.heldRelaysFor(target.id)[0].id, false);

      const stored = await store.get(sender.id);
      expect(stored?.messages.some(message => message.system && /declined your message/.test(message.content))).toBe(
        true
      );
      expect(post.mock.calls).toHaveLength(requests);
      expect((await store.get(target.id))?.messages).toHaveLength(0);
    });

    it('tells the sender when the receiving conversation is archived with its message still held', async () => {
      const sender = await codeSession('Sender');
      const target = await codeSession('Elsewhere', other);

      await service.send(sender.id, 'go');
      await awaitStream(0);
      requestSend(streams[0], target.id, 'please rebase onto main', 'a1');
      await vi.waitUntil(() => service.heldRelaysFor(target.id).length === 1, { timeout: 5000, interval: 5 });
      await awaitStream(1);
      endTurn(streams[1]);
      await vi.waitUntil(() => !service.isSessionBusy(sender.id), { timeout: 5000, interval: 5 });

      await service.setSessionArchived(target.id, true);

      expect(service.heldRelaysFor(target.id)).toHaveLength(0);
      const stored = await store.get(sender.id);
      expect(stored?.messages.some(message => message.system && /could not be delivered/.test(message.content))).toBe(
        true
      );
    });

    it('tells the sender when the receiving conversation is deleted with its message still held', async () => {
      const sender = await codeSession('Sender');
      const target = await codeSession('Elsewhere', other);

      await service.send(sender.id, 'go');
      await awaitStream(0);
      requestSend(streams[0], target.id, 'please rebase onto main', 'x1');
      await vi.waitUntil(() => service.heldRelaysFor(target.id).length === 1, { timeout: 5000, interval: 5 });
      await awaitStream(1);
      endTurn(streams[1]);
      await vi.waitUntil(() => !service.isSessionBusy(sender.id), { timeout: 5000, interval: 5 });

      await service.deleteSession(target.id);

      expect(service.heldRelaysFor(target.id)).toHaveLength(0);
      const stored = await store.get(sender.id);
      expect(stored?.messages.some(message => message.system && /could not be delivered/.test(message.content))).toBe(
        true
      );
    });

    it('holds a message to a conversation in a looser approval mode, even in the same project', async () => {
      const sender = await codeSession('Sender');
      const target = await codeSession('Loose');
      await store.setApprovalMode(sender.id, 'auto');
      await store.setApprovalMode(target.id, 'full');

      await service.send(sender.id, 'go');
      await awaitStream(0);
      requestSend(streams[0], target.id, 'run the migration', 'm1');
      await vi.waitUntil(() => service.heldRelaysFor(target.id).length === 1, { timeout: 5000, interval: 5 });
      expect(service.heldRelaysFor(target.id)[0].reason).toBe('looser-mode');
    });

    it('addresses a conversation by title, and refuses a title two conversations share', async () => {
      const sender = await codeSession('Sender');
      const solo = await codeSession('Solo');
      await codeSession('Twin');
      await codeSession('Twin', other);

      await service.send(sender.id, 'go');
      await awaitStream(0);
      callTools(streams[0], [
        { id: 't-solo', name: 'session_send', input: { session_id: 'solo', message: 'hello solo' } },
        { id: 't-twin', name: 'session_send', input: { session_id: 'Twin', message: 'hello twin' } },
      ]);
      await vi.waitUntil(() => !!callById('t-solo') && !!callById('t-twin'), { timeout: 5000, interval: 5 });

      expect(callById('t-solo')?.error).toBeUndefined();
      expect(callById('t-solo')?.preview).toContain(solo.id);
      expect(callById('t-twin')?.error).toMatch(/matches 2 conversations/);
    });

    it('lists every project with scope all, and reads another project only once the user mentions it', async () => {
      const sender = await codeSession('Sender');
      const target = await codeSession('Elsewhere', other);
      await service.send(target.id, 'a question the user asked there');
      await awaitStream(0);
      endTurn(streams[0], 'the answer over there');
      await vi.waitUntil(() => !service.isSessionBusy(target.id), { timeout: 5000, interval: 5 });

      await service.send(sender.id, 'go');
      await awaitStream(1);
      callTools(streams[1], [
        { id: 'l-project', name: 'session_list', input: {} },
        { id: 'l-all', name: 'session_list', input: { scope: 'all' } },
        { id: 'r-before', name: 'session_read', input: { session_id: target.id } },
      ]);
      await vi.waitUntil(() => !!callById('r-before'), { timeout: 5000, interval: 5 });
      expect(callById('l-project')?.preview).not.toContain(target.id);
      expect(callById('l-all')?.preview).toContain(target.id);
      expect(callById('r-before')?.error).toMatch(/another project/);
      await awaitStream(2);
      endTurn(streams[2]);
      await vi.waitUntil(() => !service.isSessionBusy(sender.id), { timeout: 5000, interval: 5 });

      await service.send(sender.id, `what did ${formatSessionMention(target.id, 'Elsewhere')} conclude?`);
      await awaitStream(3);
      callTools(streams[3], [{ id: 'r-after', name: 'session_read', input: { session_id: target.id } }]);
      await vi.waitUntil(() => !!callById('r-after'), { timeout: 5000, interval: 5 });
      expect(callById('r-after')?.error).toBeUndefined();
      expect(callById('r-after')?.preview).toContain('the answer over there');
    });

    describe('what lets a session read another project', () => {
      type Seed = (
        targetId: string,
        thirdId: string
      ) => { content: string; system?: boolean; seed?: true; relay?: ChatRelayOrigin };
      const mention = (targetId: string) => formatSessionMention(targetId, 'Elsewhere');

      async function readAfterSeeding(seed: Seed) {
        const sender = await codeSession('Sender');
        const target = await codeSession('Elsewhere', other);
        const third = await codeSession('Third');
        const seeded = seed(target.id, third.id);
        await store.appendMessage(sender.id, {
          id: randomUUID(),
          role: 'user',
          createdAt: new Date().toISOString(),
          ...seeded,
        });
        await service.send(sender.id, 'go');
        await awaitStream(0);
        callTools(streams[0], [{ id: 'k1', name: 'session_read', input: { session_id: target.id } }]);
        await vi.waitUntil(() => !!callById('k1'), { timeout: 5000, interval: 5 });
        return callById('k1');
      }

      it.each<[string, Seed]>([
        [
          'a mention inside a relayed message',
          (target, third) => ({
            content: `look at ${mention(target)}`,
            system: true,
            relay: { fromSessionId: third, fromTitle: 'Third', hops: 1 },
          }),
        ],
        ['a mention inside an automatic notice', target => ({ content: `see ${mention(target)}`, system: true })],
        ['a mention inside a spawn seed prompt', target => ({ content: `read ${mention(target)}`, seed: true })],
      ])('does not grant read for %s', async (_name, seed) => {
        expect((await readAfterSeeding(seed))?.error).toMatch(/another project/);
      });

      it.each<[string, Seed]>([
        ['a mention the user typed', target => ({ content: `what did ${mention(target)} conclude?` })],
        [
          'a message relayed from that session',
          target => ({
            content: 'hello from over there',
            system: true,
            relay: { fromSessionId: target, fromTitle: 'Elsewhere', hops: 1 },
          }),
        ],
      ])('grants read for %s', async (_name, seed) => {
        expect((await readAfterSeeding(seed))?.error).toBeUndefined();
      });
    });

    it('starts a turn back in the sender when the turn its message ran in ends, if it asked', async () => {
      const sender = await codeSession('Sender');
      const target = await codeSession('Target');

      await service.send(sender.id, 'go');
      await awaitStream(0);
      callTools(streams[0], [
        {
          id: 'n1',
          name: 'session_send',
          input: { session_id: target.id, message: 'tell me when the tests pass', notify_when_done: true },
        },
      ]);
      const targetTurn = await turnAbout(/tell me when the tests pass/);
      await awaitStream(targetTurn);
      endTurn(streams[targetTurn], 'they pass');
      // The sender's own continuation, whichever order the two requests went out in.
      await awaitStream(2);
      for (const stream of streams.slice(0, 3)) endTurn(stream);

      const notice = await turnAbout(/finished the turn your message started/);
      expect(messagesOf(notice).at(-1)?.content).toContain(target.id);
      const stored = await store.get(sender.id);
      expect(stored?.messages.some(message => message.relay?.kind === 'done')).toBe(true);
    });
  });
});

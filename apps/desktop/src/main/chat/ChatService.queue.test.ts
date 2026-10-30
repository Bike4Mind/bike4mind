import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { SessionRevokedError, type AuthenticatedApiClient } from '@bike4mind/client-auth';
import {
  SESSION_EXPIRED_STOP,
  type BackgroundProcessInfo,
  type ChatQueueEvent,
  type ChatStreamEvent,
} from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import type { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import { MAX_CONSECUTIVE_WAKES } from './backgroundWake';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * Typing ahead of a live turn.
 *
 * The cases that matter most here are the ones where the turn does NOT succeed: a queued
 * message firing into a reply the user stopped, or one that errored, is the failure this
 * feature is most likely to have and the one the user would least forgive.
 */
describe('ChatService queued messages', () => {
  let store: SessionStore;
  let service: ChatService;
  let queue: MessageQueue;
  let events: ChatStreamEvent[];
  let emit: (event: ChatStreamEvent) => void;
  let queueEvents: ChatQueueEvent[];
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let apiClient: AuthenticatedApiClient | null;

  /** The stream serving the Nth completion request, created on demand as the service asks. */
  const streamFor = (index: number) => {
    streams[index] ??= new PassThrough();
    return streams[index];
  };

  const waitForEvent = (type: ChatStreamEvent['type'], after = 0) =>
    vi.waitUntil(() => events.filter(event => event.type === type).length > after, { timeout: 2000, interval: 5 });

  /**
   * A turn is announced before its request goes out, and the instruction files are read in
   * between, so "one request is in flight" is something to wait for rather than assume.
   */
  const waitForPost = (count: number) =>
    vi.waitUntil(() => post.mock.calls.length === count, { timeout: 2000, interval: 5 });

  const finishReply = async (index: number, text = 'reply') => {
    const stream = streamFor(index);
    stream.write(frame({ type: 'content', text, stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
  };

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-queue-')), 'test-model');
    // Bound per test: a previous service replying late must not push into this test's events.
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    emit = event => emitted.push(event);
    queueEvents = [];
    streams = [];
    const boundPost = vi
      .fn()
      .mockImplementation(() => Promise.resolve({ data: streamFor(boundPost.mock.calls.length - 1), status: 200 }));

    apiClient = {
      get: vi.fn().mockResolvedValue({ sseCompletionsUrl: '' }),
      getAxiosInstance: () => ({ post: boundPost }),
    } as unknown as AuthenticatedApiClient;

    queue = new MessageQueue(event => queueEvents.push(event));
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      queue,
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit,
    });
    post = boundPost;
  });

  it('queues a message sent during a live reply instead of refusing it', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    await waitForPost(1);

    const result = await service.send(id, 'typed ahead');

    expect(result).toMatchObject({ ok: true, queued: true });
    expect(service.queuedMessages(id).map(message => message.text)).toEqual(['typed ahead']);
    // Nothing went out: one request is in flight, and the queued turn is not it.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sends the queued message as the next turn once the reply completes', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    await service.send(id, 'typed ahead');

    await finishReply(0);
    await waitForEvent('start', 1);

    expect(service.queuedMessages(id)).toEqual([]);
    const session = await service.getSession(id);
    expect(session?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
      'first',
      'typed ahead',
    ]);
    // The prompt reaches the renderer with the thread message it became, so the reply about to
    // stream does not appear under a blank.
    expect(queueEvents.at(-1)?.sent?.message).toMatchObject({ role: 'user', content: 'typed ahead' });
  });

  it('does NOT send a queued message when the user stops the reply, and hands it back', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    await waitForPost(1);
    await service.send(id, 'typed ahead');

    service.stop(id);
    await waitForEvent('done');

    // The whole point: stopping is the user changing their mind, so the queued turn never runs.
    expect(post).toHaveBeenCalledTimes(1);
    expect(service.queuedMessages(id)).toEqual([]);

    const returned = queueEvents.at(-1)?.returned;
    expect(returned?.reason).toBe('stopped');
    expect(returned?.messages.map(message => message.text)).toEqual(['typed ahead']);

    const session = await service.getSession(id);
    expect(session?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
      'first',
    ]);
  });

  it('does NOT send a queued message when the reply errors, and hands it back', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    await waitForPost(1);
    await service.send(id, 'typed ahead');

    streamFor(0).destroy(new Error('connection reset'));
    await waitForEvent('error');

    expect(post).toHaveBeenCalledTimes(1);
    expect(service.queuedMessages(id)).toEqual([]);
    expect(queueEvents.at(-1)?.returned?.reason).toBe('failed');
  });

  it('pauses a turn the session expired under, hands queued text back, and continues it after sign-in', async () => {
    const { id } = await service.createSession();
    post.mockImplementationOnce(async () => {
      // What the shared client throws once refresh and retry have both failed.
      apiClient = null;
      throw new SessionRevokedError('Your session expired. Sign in again to continue.');
    });
    const signedIn = apiClient;
    await service.send(id, 'first');
    await waitForEvent('start');
    await service.send(id, 'typed ahead');
    await waitForEvent('error');

    expect(events.find(event => event.type === 'error')).toMatchObject({ stopReason: SESSION_EXPIRED_STOP });
    expect(queueEvents.at(-1)?.returned).toMatchObject({ reason: 'session-expired' });
    const paused = (await service.getSession(id))?.messages.at(-1);
    expect(paused).toMatchObject({ role: 'assistant', stopReason: SESSION_EXPIRED_STOP });
    expect(await service.continueReply(id)).toMatchObject({ ok: false });
    expect(post).toHaveBeenCalledTimes(1);

    apiClient = signedIn;
    expect(await service.continueReply(id)).toMatchObject({ ok: true, messageId: paused?.id });
    await waitForPost(2);
    await finishReply(1, 'answer');
    await waitForEvent('done');

    const messages = (await service.getSession(id))?.messages ?? [];
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(messages.at(-1)).toMatchObject({ content: 'answer', stopReason: 'end_turn' });
    expect(messages.at(-1)?.error).toBeUndefined();
  });

  /**
   * A turn parked awaiting the user's answer is not a finished turn.
   *
   * Nothing checks the gate to get this right: the release is anchored to the reply promise,
   * and that promise cannot resolve while a tool is still waiting inside it. The gate is
   * genuinely entered here rather than simulated, because a test that only stalls the stream
   * would pass even if the release had been wired to a status flag instead.
   */
  it('holds a queued message while a tool sits at the approval gate', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-queue-root-')));
    const gated = new ChatService({
      store,
      access: { list: async () => [root] } as unknown as AccessStore,
      approvals: new ApprovalGate(),
      logger: { debug: vi.fn(), warn: vi.fn() },
      queue,
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit,
    });

    const { id } = await gated.createSession();
    // 'ask', not the default: a queued message parked behind the gate needs the gate to hold,
    // and under 'auto' this command would never reach it.
    await gated.setApprovalMode(id, 'ask');
    await gated.send(id, 'what is on port 3000?');
    await waitForEvent('start');

    streamFor(0).write(
      frame({ type: 'tool_use', tools: [{ id: 'call_1', name: 'bash_execute', arguments: '{"command":"echo hi"}' }] })
    );
    streamFor(0).write(frame('[DONE]'));

    await vi.waitUntil(
      () => events.some(event => (event.type === 'tool-start' || event.type === 'tool-end') && event.call.approvalId),
      { timeout: 3000, interval: 5 }
    );

    expect(await gated.send(id, 'typed ahead')).toMatchObject({ ok: true, queued: true });

    // Still parked. One request has gone out - the one that asked for the tool - and the queued
    // message has not jumped the gate to become a second.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(post).toHaveBeenCalledTimes(1);
    expect(gated.queuedMessages(id).map(message => message.text)).toEqual(['typed ahead']);
  });

  /**
   * One pending message, not a line of them.
   *
   * Sending again while something is already waiting APPENDS to it, so the whole wait produces
   * a single next turn carrying everything the user said. The alternative - a separate turn per
   * keystroke burst - sets several unattended turns running off one wait, and the user who
   * typed two halves of one thought gets them answered separately.
   */
  it('appends a second send to the message already waiting, as one next turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    await service.send(id, 'second');
    await service.send(id, 'third');

    expect(service.queuedMessages(id).map(message => message.text)).toEqual(['second\nthird']);

    await finishReply(0);
    await waitForEvent('start', 1);

    expect(service.queuedMessages(id)).toEqual([]);
    const session = await service.getSession(id);
    expect(session?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
      'first',
      'second\nthird',
    ]);
    // One further turn, not two.
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keeps the same pending message across appends, so one cancel takes all of it back', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    const initial = await service.send(id, 'second');
    const appended = await service.send(id, 'third');

    const initialId = initial.ok && initial.queued ? initial.message.id : 'a';
    const appendedId = appended.ok && appended.queued ? appended.message.id : 'b';
    expect(appendedId).toBe(initialId);

    service.cancelQueued(id, initialId);
    expect(service.queuedMessages(id)).toEqual([]);
    expect(queueEvents.at(-1)?.returned?.messages.map(message => message.text)).toEqual(['second\nthird']);
  });

  it('returns everything typed during the turn when it is stopped', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    await waitForPost(1);
    await service.send(id, 'second');
    await service.send(id, 'third');

    service.stop(id);
    await waitForEvent('done');

    expect(post).toHaveBeenCalledTimes(1);
    expect(queueEvents.at(-1)?.returned?.messages.map(message => message.text)).toEqual(['second\nthird']);
  });

  it('hands a queued message back when its own turn is refused', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    await service.send(id, 'typed ahead');

    // Signed out between queueing and its turn: the message must not evaporate with the error.
    apiClient = null;
    await finishReply(0);
    await vi.waitUntil(() => queueEvents.at(-1)?.returned !== undefined, { timeout: 2000, interval: 5 });

    const returned = queueEvents.at(-1)?.returned;
    expect(returned?.reason).toBe('refused');
    expect(returned?.detail).toMatch(/sign in/i);
    expect(returned?.messages.map(message => message.text)).toEqual(['typed ahead']);
    expect(service.queuedMessages(id)).toEqual([]);
  });

  it('lets the user take a queued message back before it sends', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    const queued = await service.send(id, 'typed ahead');
    expect(queued.ok && queued.queued).toBe(true);

    service.cancelQueued(id, queued.ok && queued.queued ? queued.message.id : '');

    expect(service.queuedMessages(id)).toEqual([]);
    expect(queueEvents.at(-1)?.returned?.reason).toBe('cancelled');

    await finishReply(0);
    await waitForEvent('done');
    // Cancelled means cancelled: the completed turn releases nothing.
    expect(post).toHaveBeenCalledTimes(1);
  });

  /**
   * A spawned child's report and a queued message both append to THIS session, and
   * SessionStore.appendMessage is a read-modify-write with no lock - so if the queue flush
   * started its turn while the report was still being written, one of the two would be lost.
   * The report is awaited first, which also keeps it above the turn that answers it.
   */
  it('lands a child report before the queued turn it arrives alongside', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');
    await service.send(id, 'typed ahead');

    // Reached through a cast rather than by running a real spawn: the delivery path is what
    // this pins, and widening ChatService's API for a test would be the worse trade. A report
    // arriving mid-turn is held until the turn ends - the same moment the queue is released.
    const internals = service as unknown as {
      deliverChildReport(sessionId: string, report: { content: string; display: string }): Promise<void>;
    };
    await internals.deliverChildReport(id, {
      content: 'a spawned session finished',
      display: 'The session has finished.',
    });

    await finishReply(0);
    await waitForEvent('start', 1);
    await vi.waitUntil(async () => ((await service.getSession(id))?.messages.length ?? 0) >= 4, {
      timeout: 2000,
      interval: 5,
    });

    const session = await service.getSession(id);
    expect(session?.messages.map(message => [message.role, message.system === true, message.content])).toEqual([
      ['user', false, 'first'],
      ['assistant', false, 'reply'],
      ['user', true, 'a spawned session finished'],
      ['user', false, 'typed ahead'],
      // The queued turn's own reply, still streaming.
      ['assistant', false, ''],
    ]);
  });

  /**
   * "Send now": the explicit exception to the rule the rest of this file pins down.
   *
   * Stopping a reply normally hands the queue BACK, because a stop usually means the user
   * changed their mind about the thing they were queueing against. Here they said the
   * opposite, so the message goes out - and the interrupt and the promotion have to be one
   * step, or the give-back races the send and the text is either lost or sent twice.
   */
  describe('send now', () => {
    const queuedId = (result: Awaited<ReturnType<ChatService['send']>>) =>
      result.ok && result.queued ? result.message.id : '';

    it('interrupts the live reply and runs the queued message next', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'first');
      await waitForEvent('start');
      await waitForPost(1);
      // Partial text from the turn that is about to be interrupted.
      streamFor(0).write(frame({ type: 'content', text: 'half an answer' }));
      const queued = await service.send(id, 'actually, this instead');

      service.sendQueuedNow(id, queuedId(queued));

      await waitForPost(2);
      await waitForEvent('start', 1);

      expect(service.queuedMessages(id)).toEqual([]);
      // Nothing came back to the composer: that is the whole difference from a plain stop.
      expect(queueEvents.some(event => event.returned)).toBe(false);
      expect(queueEvents.at(-1)?.sent?.message).toMatchObject({ role: 'user', content: 'actually, this instead' });

      const session = await service.getSession(id);
      expect(session?.messages.map(message => [message.role, message.content])).toEqual([
        ['user', 'first'],
        // Interrupted, not discarded - what the turn had already produced stays, exactly as
        // for an ordinary stop.
        ['assistant', 'half an answer'],
        ['user', 'actually, this instead'],
        ['assistant', ''],
      ]);
    });

    it('sends the named message and leaves the rest of the queue in order', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'first');
      await waitForEvent('start');
      await waitForPost(1);

      // A relay sits in front of what the user typed, so the head is NOT the message they
      // mean. Promoting by id rather than FIFO is what gets this right.
      queue.enqueueRelay(id, 'from the other conversation', {
        fromSessionId: 'sender',
        fromTitle: 'Sender',
        hops: 1,
      });
      const mine = await service.send(id, 'mine, and urgently');

      service.sendQueuedNow(id, queuedId(mine));
      await waitForPost(2);
      await waitForEvent('start', 1);

      // The relay is untouched and still waiting its turn, which comes when this one ends.
      expect(service.queuedMessages(id).map(message => [message.text, Boolean(message.relay)])).toEqual([
        ['from the other conversation', true],
      ]);
      const session = await service.getSession(id);
      expect(session?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
        'first',
        'mine, and urgently',
      ]);
    });

    it('refuses to fire a relayed message as if the user had written it', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'first');
      await waitForEvent('start');
      await waitForPost(1);
      queue.enqueueRelay(id, 'from the other conversation', {
        fromSessionId: 'sender',
        fromTitle: 'Sender',
        hops: 1,
      });
      const relayed = service.queuedMessages(id)[0];

      service.sendQueuedNow(id, relayed?.id ?? '');

      // Nothing interrupted and nothing promoted: another conversation's words jumping this
      // user's turn is not something they asked for.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(post).toHaveBeenCalledTimes(1);
      expect(service.queuedMessages(id).map(message => message.text)).toEqual(['from the other conversation']);
    });

    it('is a no-op when the turn finished first', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'first');
      await waitForEvent('start');
      const queued = await service.send(id, 'typed ahead');

      // The reply ends on its own between the click and the IPC arriving, draining the queue
      // the ordinary way. The click that follows must not send a second copy.
      await finishReply(0);
      await waitForEvent('start', 1);
      service.sendQueuedNow(id, queuedId(queued));

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(post).toHaveBeenCalledTimes(2);
      const session = await service.getSession(id);
      expect(session?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
        'first',
        'typed ahead',
      ]);
    });

    it('ignores a second click while the first is still unwinding', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'first');
      await waitForEvent('start');
      await waitForPost(1);
      const queued = await service.send(id, 'typed ahead');

      service.sendQueuedNow(id, queuedId(queued));
      // Same message, and the message is already out of the queue by now: a second promotion
      // would have nothing to promote, and must not disturb the one in flight.
      service.sendQueuedNow(id, queuedId(queued));

      await waitForPost(2);
      await waitForEvent('start', 1);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(post).toHaveBeenCalledTimes(2);
      const session = await service.getSession(id);
      expect(session?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
        'first',
        'typed ahead',
      ]);
    });

    it('hands a promoted message back when its own turn is refused', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'first');
      await waitForEvent('start');
      await waitForPost(1);
      const queued = await service.send(id, 'typed ahead');

      // Signed out between the click and the promoted turn: it is out of the queue by then, so
      // it has to be handed back explicitly or it evaporates with the error.
      apiClient = null;
      service.sendQueuedNow(id, queuedId(queued));
      await vi.waitUntil(() => queueEvents.at(-1)?.returned !== undefined, { timeout: 2000, interval: 5 });

      const returned = queueEvents.at(-1)?.returned;
      expect(returned?.reason).toBe('refused');
      expect(returned?.messages.map(message => message.text)).toEqual(['typed ahead']);
      expect(service.queuedMessages(id)).toEqual([]);
    });

    /**
     * A turn parked at the approval gate is interrupted exactly as the stop button interrupts
     * it: the abort settles the pending request as a DENY (see ApprovalGate.request) and the
     * turn unwinds. That is an interrupt, not an answer given on the user's behalf - denying
     * ends the turn, where approving would carry it on and run the tool.
     */
    it('interrupts a turn parked at the approval gate, denying what it was asking for', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-sendnow-root-')));
      const gated = new ChatService({
        store,
        access: { list: async () => [root] } as unknown as AccessStore,
        approvals: new ApprovalGate(),
        logger: { debug: vi.fn(), warn: vi.fn() },
        queue,
        getApiClient: () => apiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit,
      });

      const { id } = await gated.createSession();
      await gated.setApprovalMode(id, 'ask');
      await gated.send(id, 'what is on port 3000?');
      await waitForEvent('start');
      streamFor(0).write(
        frame({ type: 'tool_use', tools: [{ id: 'call_1', name: 'bash_execute', arguments: '{"command":"echo hi"}' }] })
      );
      streamFor(0).write(frame('[DONE]'));
      await vi.waitUntil(
        () => events.some(event => (event.type === 'tool-start' || event.type === 'tool-end') && event.call.approvalId),
        { timeout: 3000, interval: 5 }
      );

      const queued = await gated.send(id, 'never mind, do this');
      gated.sendQueuedNow(id, queuedId(queued));

      await waitForPost(2);
      await waitForEvent('start', 1);
      expect(gated.queuedMessages(id)).toEqual([]);
      expect(queueEvents.some(event => event.returned)).toBe(false);
      const session = await gated.getSession(id);
      expect(session?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
        'what is on port 3000?',
        'never mind, do this',
      ]);
    });

    it('does nothing without a queue configured', () => {
      const plain = new ChatService({
        store,
        access: { list: async () => [] } as unknown as AccessStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => apiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit,
      });
      expect(() => plain.sendQueuedNow('no-such-session', 'no-such-id')).not.toThrow();
    });
  });

  it('refuses a message that could never be sent rather than queueing it', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await waitForEvent('start');

    expect(await service.send(id, '   ')).toMatchObject({ ok: false });
    expect(await service.send('no-such-session', 'hello')).toMatchObject({ ok: false });
    expect(service.queuedMessages(id)).toEqual([]);
  });

  it('still refuses a concurrent send when no queue is configured', async () => {
    const plain = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit,
    });
    const { id } = await plain.createSession();
    await plain.send(id, 'first');
    await waitForEvent('start');

    expect(await plain.send(id, 'typed ahead')).toMatchObject({ ok: false, error: expect.stringMatching(/replying/i) });
  });

  /**
   * A message typed while a reply is running reaches it at the next round boundary instead of
   * waiting for the whole turn: the model reads it alongside the round's tool results, and the
   * thread shows it after the rounds it followed.
   */
  describe('delivery into a running turn', () => {
    type WireMessage = { role: string; content: unknown };
    const requestMessages = (index: number) => post.mock.calls[index][1].messages as WireMessage[];
    const askForTool = (index: number) => {
      // An unknown tool settles at once with an error result: no approval, no folders needed.
      streamFor(index).write(
        frame({ type: 'tool_use', tools: [{ id: `call_${index}`, name: 'no_such_tool', arguments: '{}' }] })
      );
      streamFor(index).write(frame('[DONE]'));
    };

    it('hands a typed message to the next request after the tool results and clears the row', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'build it');
      await waitForPost(1);
      const queued = await service.send(id, 'what are you building?');
      expect(queued).toMatchObject({ ok: true, queued: true });

      askForTool(0);
      await waitForPost(2);

      const wire = requestMessages(1);
      expect(wire.at(-2)).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0' }] });
      // An array, not a string: see ChatService.arrivalWire.
      const last = wire.at(-1) as { role: string; content: { type: string; text: string }[] };
      expect(last.role).toBe('user');
      expect(last.content).toHaveLength(1);
      expect(last.content[0].text).toMatch(/^what are you building\?\n\n<system-reminder>\nThe user sent this while/);

      expect(service.queuedMessages(id)).toEqual([]);
      const sent = queueEvents.at(-1);
      expect(sent?.queued).toEqual([]);
      expect(sent?.sent?.message).toMatchObject({ role: 'user', content: 'what are you building?' });
      expect(queueEvents.some(event => event.returned)).toBe(false);

      await finishReply(1, 'docker images');
      await vi.waitUntil(() => events.filter(event => event.type === 'done').length === 2, { timeout: 2000 });

      // Exactly one request per round: no extra turn was started for the delivered message.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(post).toHaveBeenCalledTimes(2);
      const session = await service.getSession(id);
      expect(session?.messages.map(message => [message.role, message.content, message.toolCalls?.length ?? 0])).toEqual(
        [
          ['user', 'build it', 0],
          ['assistant', '', 1],
          ['user', 'what are you building?', 0],
          ['assistant', 'docker images', 0],
        ]
      );
      // Each half of the reply is announced as its own message, so the thread draws the question between them.
      const starts = events.filter(event => event.type === 'start').map(event => event.messageId);
      expect(new Set(starts).size).toBe(2);
      expect(session?.messages[1].id).toBe(starts[0]);
      expect(session?.messages[3].id).toBe(starts[1]);
    });

    it('replays the delivered message in the same place on the next turn', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'build it');
      await waitForPost(1);
      await service.send(id, 'what are you building?');
      askForTool(0);
      await waitForPost(2);
      await finishReply(1, 'docker images');
      await vi.waitUntil(() => events.filter(event => event.type === 'done').length === 2, { timeout: 2000 });

      await service.send(id, 'thanks');
      await waitForPost(3);
      const roles = requestMessages(2)
        .filter(message => message.role !== 'system')
        .map(message => [
          message.role,
          Array.isArray(message.content) ? (message.content[0] as { type: string }).type : 'text',
        ]);
      expect(roles).toEqual([
        ['user', 'text'],
        ['assistant', 'tool_use'],
        ['user', 'tool_result'],
        ['user', 'text'],
        ['assistant', 'text'],
        ['user', 'text'],
      ]);
    });

    it('leaves a relay for the end of the turn', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'build it');
      await waitForPost(1);
      queue.enqueueRelay(id, 'from the other conversation', { fromSessionId: 'sender', fromTitle: 'Sender', hops: 1 });

      askForTool(0);
      await waitForPost(2);

      expect(service.queuedMessages(id).map(message => message.text)).toEqual(['from the other conversation']);
      expect(JSON.stringify(requestMessages(1))).not.toContain('from the other conversation');

      await finishReply(1);
      await waitForPost(3);
      expect(service.queuedMessages(id)).toEqual([]);
    });

    it('sends the message as a turn of its own when the round it waited for is the last', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'build it');
      await waitForPost(1);
      await service.send(id, 'typed ahead');

      // No tool: the reply ends on this request, so there is no boundary to deliver at.
      await finishReply(0);
      await waitForPost(2);

      const session = await service.getSession(id);
      expect(session?.messages.map(message => [message.role, message.content])).toEqual([
        ['user', 'build it'],
        ['assistant', 'reply'],
        ['user', 'typed ahead'],
        ['assistant', ''],
      ]);
    });

    it('keeps a delivered message in the thread when the reply is then stopped', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'build it');
      await waitForPost(1);
      await service.send(id, 'what are you building?');
      askForTool(0);
      await waitForPost(2);

      service.stop(id);
      await vi.waitUntil(() => events.filter(event => event.type === 'done').length === 2, { timeout: 2000 });

      // Already sent, so a stop has nothing to hand back to the composer.
      expect(queueEvents.some(event => event.returned)).toBe(false);
      const session = await service.getSession(id);
      expect(session?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
        'build it',
        'what are you building?',
      ]);
    });

    it('does not deliver a message that "send now" has already taken', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'build it');
      await waitForPost(1);
      const queued = await service.send(id, 'now, please');
      service.sendQueuedNow(id, queued.ok && queued.queued ? queued.message.id : '');

      await waitForPost(2);
      await waitForEvent('start', 1);
      const session = await service.getSession(id);
      expect(session?.messages.filter(message => message.content === 'now, please')).toHaveLength(1);
    });
  });

  /**
   * A background command the agent started ends on its own: an idle conversation is woken with
   * an automatic turn, and a busy one is told at its next round boundary.
   */
  describe('background exit wake', () => {
    let exits: Map<string, { info: BackgroundProcessInfo; tail: string }>;
    let woken: ChatService;

    const exited = (id: string, sessionId: string, exitCode = 0): void => {
      exits.set(id, {
        info: {
          id,
          sessionId,
          command: 'docker build .',
          cwd: '/work',
          status: 'exited',
          exitCode,
          startedAt: new Date().toISOString(),
          bufferedChars: 0,
          droppedChars: 0,
        },
        tail: 'Successfully built abc123',
      });
      woken.backgroundExited(sessionId, id);
    };

    beforeEach(() => {
      exits = new Map();
      const background = {
        takeExitNotice: (id: string) => {
          const entry = exits.get(id) ?? null;
          exits.delete(id);
          return entry;
        },
        list: () => [],
        sessionsWithRunning: () => new Set<string>(),
        killSession: async () => undefined,
      } as unknown as BackgroundProcessRegistry;
      woken = new ChatService({
        store,
        access: { list: async () => [] } as unknown as AccessStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
        queue,
        background,
        backgroundWakeDelayMs: 10,
        getApiClient: () => apiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit,
      });
    });

    it('wakes an idle conversation with one notice for exits that land together', async () => {
      const { id } = await woken.createSession();
      exited('aaaa1111', id);
      exited('bbbb2222', id, 1);

      await waitForPost(1);
      const session = await woken.getSession(id);
      const notice = session?.messages[0];
      expect(notice).toMatchObject({
        role: 'user',
        system: true,
        automatic: { kind: 'background-exit', processIds: ['aaaa1111', 'bbbb2222'] },
        display: 'Background command finished: [aaaa1111] exited 0, [bbbb2222] exited 1',
      });
      expect(notice?.content).toContain('Successfully built abc123');
      expect(notice?.content).toContain('This is not the user typing.');
    });

    it('still wakes when the exit came due during a send that was then refused', async () => {
      const slow = new ChatService({
        store,
        access: { list: async () => [] } as unknown as AccessStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
        queue,
        background: (woken as unknown as { deps: { background: BackgroundProcessRegistry } }).deps.background,
        // Long enough that only the send's own settling can be what delivers it.
        backgroundWakeDelayMs: 60_000,
        getApiClient: () => apiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit,
      });
      const { id } = await slow.createSession();
      exits.set('aaaa1111', {
        info: {
          id: 'aaaa1111',
          sessionId: id,
          command: 'docker build .',
          cwd: '/work',
          status: 'exited',
          exitCode: 0,
          startedAt: new Date().toISOString(),
          bufferedChars: 0,
          droppedChars: 0,
        },
        tail: 'done',
      });
      slow.backgroundExited(id, 'aaaa1111');

      const refused = slow.send(id, '   ');
      // What the coalesce timer does when it fires mid-send: skipped as busy.
      await (slow as unknown as { wakeForBackground(sessionId: string): Promise<void> }).wakeForBackground(id);
      expect(await refused).toMatchObject({ ok: false });

      await waitForPost(1);
      const session = await slow.getSession(id);
      expect(session?.messages[0]).toMatchObject({ automatic: { kind: 'background-exit' } });
      slow.dispose();
    });

    it('does not wake for an exit the model has already seen', async () => {
      const { id } = await woken.createSession();
      exited('aaaa1111', id);
      // What bash_output or bash_list does once it has shown the process finished.
      exits.clear();

      await new Promise(resolve => setTimeout(resolve, 80));
      expect(post).not.toHaveBeenCalled();
    });

    it('does not wake an archived conversation', async () => {
      const { id } = await woken.createSession();
      await woken.setSessionArchived(id, true);
      exited('aaaa1111', id);

      await new Promise(resolve => setTimeout(resolve, 80));
      expect(post).not.toHaveBeenCalled();
    });

    it('tells a running turn at its next round boundary instead of starting another', async () => {
      const { id } = await woken.createSession();
      await woken.send(id, 'build it');
      await waitForPost(1);
      exited('aaaa1111', id);
      await new Promise(resolve => setTimeout(resolve, 40));
      // Busy: nothing new went out.
      expect(post).toHaveBeenCalledTimes(1);

      streamFor(0).write(frame({ type: 'tool_use', tools: [{ id: 'call_0', name: 'no_such_tool', arguments: '{}' }] }));
      streamFor(0).write(frame('[DONE]'));
      await waitForPost(2);

      const last = (post.mock.calls[1][1].messages as { content: { text: string }[] }[]).at(-1);
      expect(last?.content[0].text).toContain('[aaaa1111] $ docker build .');
      await finishReply(1);
      await vi.waitUntil(() => events.filter(event => event.type === 'done').length === 2, { timeout: 2000 });
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(post).toHaveBeenCalledTimes(2);
      const session = await woken.getSession(id);
      expect(session?.messages.map(message => [message.role, message.automatic?.kind ?? null])).toEqual([
        ['user', null],
        ['assistant', null],
        ['user', 'background-exit'],
        ['assistant', null],
      ]);
    });

    it('wakes a conversation once its turn ends when the exit arrived too late for a boundary', async () => {
      const { id } = await woken.createSession();
      await woken.send(id, 'build it');
      await waitForPost(1);
      exited('aaaa1111', id);
      await new Promise(resolve => setTimeout(resolve, 40));

      await finishReply(0, 'started the build, waiting');
      await waitForPost(2);
      const session = await woken.getSession(id);
      expect(session?.messages.at(-2)).toMatchObject({ automatic: { kind: 'background-exit' } });
    });

    it('does not wake a conversation after its reply is stopped', async () => {
      const { id } = await woken.createSession();
      await woken.send(id, 'build it');
      await waitForPost(1);
      exited('aaaa1111', id);
      await new Promise(resolve => setTimeout(resolve, 40));

      woken.stop(id);
      await waitForEvent('done');
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('stops waking after a run of wakes nobody answered, until the user types', async () => {
      const { id } = await woken.createSession();
      for (let wake = 0; wake < MAX_CONSECUTIVE_WAKES; wake++) {
        exited(`proc${wake}`, id);
        await waitForPost(wake + 1);
        await finishReply(wake);
        await vi.waitUntil(() => events.filter(event => event.type === 'done').length === wake + 1, { timeout: 2000 });
      }
      exited('one-more', id);
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(post).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WAKES);

      await woken.send(id, 'what happened?');
      await waitForPost(MAX_CONSECUTIVE_WAKES + 1);
      await finishReply(MAX_CONSECUTIVE_WAKES);
      await vi.waitUntil(() => events.filter(event => event.type === 'done').length === MAX_CONSECUTIVE_WAKES + 1, {
        timeout: 2000,
      });
      exited('after-reply', id);
      await waitForPost(MAX_CONSECUTIVE_WAKES + 2);
    });
  });
});

import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatQueueEvent, ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

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
    events = [];
    queueEvents = [];
    streams = [];
    post = vi
      .fn()
      .mockImplementation(() => Promise.resolve({ data: streamFor(post.mock.calls.length - 1), status: 200 }));

    apiClient = {
      get: vi.fn().mockResolvedValue({ sseCompletionsUrl: '' }),
      getAxiosInstance: () => ({ post }),
    } as unknown as AuthenticatedApiClient;

    queue = new MessageQueue(event => queueEvents.push(event));
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      queue,
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
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
      emit: event => events.push(event),
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
        emit: event => events.push(event),
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
        emit: event => events.push(event),
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
      emit: event => events.push(event),
    });
    const { id } = await plain.createSession();
    await plain.send(id, 'first');
    await waitForEvent('start');

    expect(await plain.send(id, 'typed ahead')).toMatchObject({ ok: false, error: expect.stringMatching(/replying/i) });
  });
});

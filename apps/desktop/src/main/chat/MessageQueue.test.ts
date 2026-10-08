import type { ChatQueueEvent } from '@shared/chat';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessageQueue } from './MessageQueue';

describe('MessageQueue', () => {
  let events: ChatQueueEvent[];
  let queue: MessageQueue;

  beforeEach(() => {
    events = [];
    queue = new MessageQueue(event => events.push(event));
  });

  it('keeps one queue per session', () => {
    queue.enqueue('a', 'for a');
    queue.enqueue('b', 'for b');

    expect(queue.list('a').map(message => message.text)).toEqual(['for a']);
    expect(queue.list('b').map(message => message.text)).toEqual(['for b']);
    expect(queue.snapshot()).toHaveLength(2);
  });

  it('announces the authoritative queue on every change', () => {
    queue.enqueue('a', 'one');
    queue.enqueue('a', 'two');

    expect(events.map(event => event.queued.map(message => message.text))).toEqual([['one'], ['one\ntwo']]);
  });

  // One pending message per session: a second send joins it rather than lining up behind it.
  it('appends to the message already waiting, keeping its identity', () => {
    const first = queue.enqueue('a', 'one');
    const second = queue.enqueue('a', 'two');

    expect(second.id).toBe(first.id);
    expect(second.queuedAt).toBe(first.queuedAt);
    expect(queue.list('a').map(message => message.text)).toEqual(['one\ntwo']);
  });

  it('takes the pending message', () => {
    queue.enqueue('a', 'one');
    queue.enqueue('a', 'two');

    expect(queue.takeNext('a')?.text).toBe('one\ntwo');
    expect(queue.list('a')).toEqual([]);
  });

  // A stale click must not cancel whatever happened to be next.
  it('ignores an unknown id on cancel', () => {
    queue.enqueue('a', 'one');
    expect(queue.cancel('a', 'nope')).toBeUndefined();
    expect(queue.list('a')).toHaveLength(1);
  });

  it('hands cancelled and released messages back', () => {
    const first = queue.enqueue('a', 'one');
    queue.enqueue('a', 'two');

    queue.cancel('a', first.id);
    expect(events.at(-1)?.returned).toMatchObject({ reason: 'cancelled' });
    // One cancel takes back everything typed during the turn, because it is all one message.
    expect(events.at(-1)?.returned?.messages.map(message => message.text)).toEqual(['one\ntwo']);
    expect(queue.list('a')).toEqual([]);

    queue.enqueue('a', 'again');
    queue.releaseAll('a', 'stopped');
    expect(events.at(-1)?.returned).toMatchObject({ reason: 'stopped' });
    expect(events.at(-1)?.queued).toEqual([]);
  });

  it('says nothing when there was nothing to release', () => {
    queue.releaseAll('a', 'stopped');
    expect(events).toEqual([]);
  });

  // The refused-flush path: the head is already out of the queue and must still come back first.
  it('gives back a taken message ahead of what is still queued', () => {
    const taken = queue.enqueue('a', 'one');
    queue.takeNext('a');
    queue.enqueue('a', 'two');
    events.length = 0;

    queue.giveBack('a', [taken], 'refused', 'Sign in to send a message.');

    expect(events.at(-1)?.returned?.messages.map(message => message.text)).toEqual(['one', 'two']);
    expect(events.at(-1)?.returned?.detail).toBe('Sign in to send a message.');
    expect(queue.list('a')).toEqual([]);
  });

  // Pruning deletes attachment bytes nothing persisted references; a queued message is not
  // persisted, so its files would go with it.
  it('reports the attachments it is holding, so they survive pruning', () => {
    const shot = {
      id: 'att1',
      kind: 'image' as const,
      name: 'shot.png',
      mediaType: 'image/png',
      byteSize: 10,
      sourceBytes: 10,
    };
    queue.enqueue('a', 'look', [shot]);
    expect(queue.attachmentIds('a')).toEqual(['att1']);

    // An append carries its own files in, and re-sending the same one does not double it.
    queue.enqueue('a', 'and this', [shot, { ...shot, id: 'att2', name: 'other.png' }]);
    expect(queue.attachmentIds('a')).toEqual(['att1', 'att2']);
  });

  describe('relayed messages', () => {
    const from = { fromSessionId: 'sender', fromTitle: 'Sender', hops: 1 };

    it('keeps a relay as its own entry rather than merging it into what the user is typing', () => {
      queue.enqueue('a', 'my own message');
      queue.enqueueRelay('a', 'from elsewhere', from);
      queue.enqueue('a', 'still mine');

      // Three entries, in arrival order, with the user's second message starting a NEW one:
      // appending it to the relay would have put their words inside another session's message.
      expect(queue.list('a').map(message => message.text)).toEqual(['my own message', 'from elsewhere', 'still mine']);
      expect(queue.list('a').map(message => Boolean(message.relay))).toEqual([false, true, false]);
    });

    it('hands a released relay to the caller and never to the composer', () => {
      queue.enqueue('a', 'mine');
      queue.enqueueRelay('a', 'theirs', from);
      events.length = 0;

      const stranded = queue.releaseAll('a', 'stopped');

      expect(stranded.map(message => message.text)).toEqual(['theirs']);
      // Only the user's own text is offered back to them.
      expect(events[0]?.returned?.messages.map(message => message.text)).toEqual(['mine']);
      expect(queue.list('a')).toEqual([]);
    });

    it('still announces the empty queue when everything released was a relay', () => {
      queue.enqueueRelay('a', 'theirs', from);
      events.length = 0;

      expect(queue.releaseAll('a', 'failed').map(message => message.text)).toEqual(['theirs']);
      // No `returned` - there is nothing for the composer to take - but the list has changed, and
      // a renderer that heard nothing would keep drawing a row for a message that is gone.
      expect(events).toHaveLength(1);
      expect(events[0]?.queued).toEqual([]);
      expect(events[0]?.returned).toBeUndefined();
    });

    it('returns a cancelled relay to the caller too', () => {
      const relayed = queue.enqueueRelay('a', 'theirs', from);
      events.length = 0;

      expect(queue.cancel('a', relayed.id)?.relay).toEqual(from);
      expect(events[0]?.returned).toBeUndefined();
    });
  });

  describe('take and restore', () => {
    it('takes one message out by id, leaving the rest in order', () => {
      const relayed = queue.enqueueRelay('a', 'theirs', { fromSessionId: 'sender', fromTitle: 'Sender', hops: 1 });
      const mine = queue.enqueue('a', 'mine');
      events.length = 0;

      // By id, not position: the user's own message is BEHIND a relay here, and "send this
      // now" means that one rather than whatever happens to be at the head.
      expect(queue.take('a', mine.id)?.text).toBe('mine');
      expect(queue.list('a').map(message => message.id)).toEqual([relayed.id]);
      // Silent, like takeNext: the caller may still have to put it back.
      expect(events).toEqual([]);
    });

    it('ignores an unknown id', () => {
      queue.enqueue('a', 'one');
      expect(queue.take('a', 'no-such-id')).toBeUndefined();
      expect(queue.list('a').map(message => message.text)).toEqual(['one']);
    });

    it('restores a taken message at the head, and says so', () => {
      const first = queue.enqueue('a', 'mine');
      queue.take('a', first.id);
      queue.enqueueRelay('a', 'theirs', { fromSessionId: 'sender', fromTitle: 'Sender', hops: 1 });
      events.length = 0;

      queue.restore('a', first);

      expect(queue.list('a').map(message => message.text)).toEqual(['mine', 'theirs']);
      // Announced, unlike take: the row is back on screen, and the renderer replaces rather
      // than reconciles, so it would otherwise never hear that it returned.
      expect(events).toHaveLength(1);
      expect(events[0]?.queued.map(message => message.text)).toEqual(['mine', 'theirs']);
      expect(events[0]?.returned).toBeUndefined();
    });
  });

  it('forgets a deleted conversation silently', () => {
    queue.enqueue('a', 'one');
    events.length = 0;
    queue.forget('a');

    expect(queue.list('a')).toEqual([]);
    expect(events).toEqual([]);
  });
  describe('automatic turns', () => {
    const origin = {
      kind: 'auto-fix' as const,
      prUrl: 'https://github.com/example-org/widgets/pull/611',
      prNumber: 611,
      summary: '1 failing check on #611',
    };

    it('keeps an automatic turn apart from what the user types', () => {
      queue.enqueueAutomatic('a', 'fix it', origin);
      queue.enqueue('a', 'mine');

      expect(queue.list('a').map(message => message.text)).toEqual(['fix it', 'mine']);
    });

    it('never hands an automatic turn to the composer or back to the caller', () => {
      queue.enqueueAutomatic('a', 'fix it', origin);
      queue.enqueue('a', 'mine');

      const back = queue.releaseAll('a', 'stopped');

      expect(back).toEqual([]);
      expect(events[events.length - 1].returned?.messages.map(message => message.text)).toEqual(['mine']);
    });
  });
});

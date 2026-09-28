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

    expect(events.map(event => event.queued.map(message => message.text))).toEqual([['one'], ['one', 'two']]);
  });

  it('takes from the head', () => {
    queue.enqueue('a', 'one');
    queue.enqueue('a', 'two');

    expect(queue.takeNext('a')?.text).toBe('one');
    expect(queue.list('a').map(message => message.text)).toEqual(['two']);
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
    expect(events.at(-1)?.returned?.messages.map(message => message.text)).toEqual(['one']);

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
    queue.enqueue('a', 'look', [
      { id: 'att1', kind: 'image', name: 'shot.png', mediaType: 'image/png', byteSize: 10, sourceBytes: 10 },
    ]);
    expect(queue.attachmentIds('a')).toEqual(['att1']);
  });

  it('forgets a deleted conversation silently', () => {
    queue.enqueue('a', 'one');
    events.length = 0;
    queue.forget('a');

    expect(queue.list('a')).toEqual([]);
    expect(events).toEqual([]);
  });
});

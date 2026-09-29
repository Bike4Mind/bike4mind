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

  it('forgets a deleted conversation silently', () => {
    queue.enqueue('a', 'one');
    events.length = 0;
    queue.forget('a');

    expect(queue.list('a')).toEqual([]);
    expect(events).toEqual([]);
  });
});

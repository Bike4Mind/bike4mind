import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionBackgroundJobs } from '@shared/chat';
import { BackgroundJobsFeed } from './backgroundJobsFeed';

describe('BackgroundJobsFeed', () => {
  let applied: [string, SessionBackgroundJobs | undefined][];
  let feed: BackgroundJobsFeed;
  const jobs = { running: 1, label: 'pnpm test' };

  beforeEach(() => {
    vi.useFakeTimers();
    applied = [];
    feed = new BackgroundJobsFeed((sessionId, value) => applied.push([sessionId, value]), 2_500);
  });

  afterEach(() => {
    feed.dispose();
    vi.useRealTimers();
  });

  it('applies a starting job at once', () => {
    feed.update('a', jobs, 'running');
    expect(applied).toEqual([['a', jobs]]);
  });

  it('holds Waiting after the last job ends on its own, then clears', () => {
    feed.update('a', jobs, 'running');
    feed.update('a', undefined, 'exited');
    expect(applied).toEqual([['a', jobs]]);

    vi.advanceTimersByTime(2_499);
    expect(applied).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual([
      ['a', jobs],
      ['a', undefined],
    ]);
  });

  it('treats a failed job like one that exited', () => {
    feed.update('a', undefined, 'failed');
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(2_500);
    expect(applied).toEqual([['a', undefined]]);
  });

  it('clears a killed job at once, since no wake follows a kill', () => {
    feed.update('a', jobs, 'running');
    feed.update('a', undefined, 'killed');
    expect(applied.at(-1)).toEqual(['a', undefined]);
  });

  it('applies a remaining count at once and drops a pending hold when a new job starts', () => {
    feed.update('a', undefined, 'exited');
    feed.update('a', jobs, 'running');
    vi.advanceTimersByTime(5_000);
    expect(applied).toEqual([['a', jobs]]);

    feed.update('a', { running: 1, label: 'other' }, 'exited');
    expect(applied.at(-1)).toEqual(['a', { running: 1, label: 'other' }]);
  });

  it('keeps holds per session', () => {
    feed.update('a', undefined, 'exited');
    feed.update('b', undefined, 'killed');
    expect(applied).toEqual([['b', undefined]]);
    vi.advanceTimersByTime(2_500);
    expect(applied).toEqual([
      ['b', undefined],
      ['a', undefined],
    ]);
  });
});

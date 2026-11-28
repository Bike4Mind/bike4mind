import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { receiveRows, SessionDirectory, summaryHostId, withHostStamp } from './sessionDirectory';

const row = (id: string): ChatSessionSummary =>
  ({
    id,
    title: id,
    mode: 'code',
    messageCount: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  }) as ChatSessionSummary;

describe('SessionDirectory', () => {
  it('maps each recorded session to its host', () => {
    const directory = new SessionDirectory();
    directory.record(LOCAL_HOST_ID, ['a']);
    directory.record('devbox', ['b']);
    expect(directory.hostOf('a')).toBe(LOCAL_HOST_ID);
    expect(directory.hostOf('b')).toBe('devbox');
    expect(directory.hostOf('c')).toBeUndefined();
  });

  it('keeps the first host and reports a second host listing the same id', () => {
    const reportClash = vi.fn();
    const directory = new SessionDirectory(reportClash);
    directory.record(LOCAL_HOST_ID, ['same']);
    expect([...directory.record('devbox', ['same', 'other'])]).toEqual(['same']);
    expect(directory.hostOf('same')).toBe(LOCAL_HOST_ID);
    expect(reportClash).toHaveBeenCalledWith('same', LOCAL_HOST_ID, 'devbox');
  });

  it('forgets single sessions and a whole host', () => {
    const directory = new SessionDirectory();
    directory.record('devbox', ['a', 'b']);
    directory.record(LOCAL_HOST_ID, ['c']);
    directory.forget(['a']);
    expect(directory.hostOf('a')).toBeUndefined();
    directory.forgetHost('devbox');
    expect(directory.hostOf('b')).toBeUndefined();
    expect(directory.hostOf('c')).toBe(LOCAL_HOST_ID);
  });
});

describe('receiveRows', () => {
  it('leaves local rows exactly as main sent them', () => {
    const rows = [row('a')];
    const [received] = receiveRows(LOCAL_HOST_ID, rows, new SessionDirectory());
    expect(received).toBe(rows[0]);
    expect(summaryHostId(received)).toBe(LOCAL_HOST_ID);
  });

  it('stamps remote rows and drops one another host already holds', () => {
    const directory = new SessionDirectory(() => undefined);
    receiveRows(LOCAL_HOST_ID, [row('clash')], directory);
    const received = receiveRows('devbox', [row('clash'), row('mine')], directory);
    expect(received.map(r => [r.id, r.hostId])).toEqual([['mine', 'devbox']]);
    expect(summaryHostId(received[0])).toBe('devbox');
  });

  it('withHostStamp returns an already stamped row unchanged', () => {
    const stamped = withHostStamp(row('a'), 'devbox');
    expect(withHostStamp(stamped, 'devbox')).toBe(stamped);
  });
});

describe('SessionDirectory expected hosts', () => {
  it('routes an expected session to its host until a listing places it, without a clash', () => {
    const reportClash = vi.fn();
    const directory = new SessionDirectory(reportClash);
    directory.expect('devbox', ['remembered']);
    expect(directory.hostOf('remembered')).toBe('devbox');

    expect(directory.record('nas', ['remembered'])).toEqual(new Set());
    expect(directory.hostOf('remembered')).toBe('nas');
    expect(reportClash).not.toHaveBeenCalled();

    directory.expect('devbox', ['remembered']);
    expect(directory.hostOf('remembered')).toBe('nas');
  });

  it('forgets expected sessions with their host', () => {
    const directory = new SessionDirectory();
    directory.expect('devbox', ['a']);
    directory.forgetHost('devbox');
    expect(directory.hostOf('a')).toBeUndefined();
  });

  it('tells subscribers once per batch of changes, and not for a change that changes nothing', async () => {
    const directory = new SessionDirectory();
    const listener = vi.fn();
    const off = directory.subscribe(listener);

    directory.record('devbox', ['a']);
    directory.forget(['a']);
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    directory.forget(['a']);
    directory.record(LOCAL_HOST_ID, []);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    directory.record('devbox', ['b']);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from 'vitest';
import type { DevLogRecord } from '@shared/devLog';
import { KEPT_RECORDS, formatForCopy, formatRecord, mergeRecords, visibleRecords } from './devLogView';

function record(id: number, tags: string[], message = `line ${id}`): DevLogRecord {
  return { id, at: 0, tags, message };
}

describe('mergeRecords', () => {
  it('appends a batch', () => {
    const merged = mergeRecords([record(1, ['a'])], [record(2, ['a']), record(3, ['a'])]);
    expect(merged.map(entry => entry.id)).toEqual([1, 2, 3]);
  });

  it('folds in a snapshot that arrived after a push', () => {
    const merged = mergeRecords([record(5, ['a'])], [record(3, ['a']), record(4, ['a']), record(5, ['a'])]);
    expect(merged.map(entry => entry.id)).toEqual([3, 4, 5]);
  });

  it('keeps only the newest records once the cap is reached', () => {
    const batch = Array.from({ length: KEPT_RECORDS + 10 }, (_value, index) => record(index + 1, ['a']));
    const merged = mergeRecords([], batch);
    expect(merged).toHaveLength(KEPT_RECORDS);
    expect(merged[0].id).toBe(11);
  });
});

describe('visibleRecords', () => {
  const records = [
    record(1, ['chat-stream']),
    record(2, ['chat-stream']),
    record(3, ['auth']),
    record(4, ['auth', 'retry']),
  ];

  it('shows everything with no tag selected', () => {
    expect(visibleRecords(records, new Set())).toHaveLength(4);
  });

  it('shows a line carrying ANY selected tag', () => {
    expect(visibleRecords(records, new Set(['auth'])).map(entry => entry.id)).toEqual([3, 4]);
    expect(visibleRecords(records, new Set(['chat-stream', 'retry'])).map(entry => entry.id)).toEqual([1, 2, 4]);
  });

  it('shows nothing when no line carries the tag', () => {
    expect(visibleRecords(records, new Set(['nope']))).toHaveLength(0);
  });
});

describe('formatting', () => {
  it('renders a line with its tags and fields', () => {
    const line = formatRecord({
      id: 1,
      at: 0,
      tags: ['chat-stream'],
      message: 'upstream content',
      fields: { chars: 4 },
    });
    expect(line).toContain('[chat-stream]');
    expect(line).toContain('upstream content');
    expect(line).toContain('chars=4');
  });

  it('copies one line per record', () => {
    expect(formatForCopy([record(1, ['a']), record(2, ['b'])]).split('\n')).toHaveLength(2);
  });
});

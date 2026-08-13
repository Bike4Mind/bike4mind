import { describe, it, expect, vi } from 'vitest';
import type { RecordLakeAccessEventInput } from '@bike4mind/common';
import { recordLakeAccessEvent } from './recordLakeAccessEvent';

const INPUT: RecordLakeAccessEventInput = {
  principalKind: 'user',
  principalId: 'user-1',
  resolvedLakeIds: ['lake1'],
  surface: 'data-lake-semantic-search',
};

describe('recordLakeAccessEvent', () => {
  it('is a no-op when no recorder was wired in', () => {
    const logger = { error: vi.fn() };
    expect(() => recordLakeAccessEvent(undefined, INPUT, logger)).not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('calls record() with the given input and does not await it', () => {
    let resolveRecord!: () => void;
    const record = vi.fn(() => new Promise<never>(resolve => (resolveRecord = resolve as () => void)));
    const logger = { error: vi.fn() };

    recordLakeAccessEvent({ record }, INPUT, logger);

    expect(record).toHaveBeenCalledWith(INPUT);
    // Function returns synchronously - the caller's own response never waits on this.
    resolveRecord();
  });

  it('logs and swallows a thrown/rejected record() instead of propagating it', async () => {
    const err = new Error('mongo blip');
    const record = vi.fn().mockRejectedValue(err);
    const logger = { error: vi.fn() };

    recordLakeAccessEvent({ record }, INPUT, logger);
    // Let the rejection's .catch() microtask run.
    await new Promise(resolve => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalledWith('[lakeAccessAudit] failed to record access event', err);
  });
});

import { describe, expect, it } from 'vitest';
import { eventCursorSchema } from './cursor';

describe('eventCursorSchema', () => {
  it('accepts an epoch and a non-negative integer seq', () => {
    expect(eventCursorSchema.safeParse({ epoch: 'e1', seq: 0 }).success).toBe(true);
  });

  it('rejects an empty epoch, a negative or fractional seq, and a missing field', () => {
    expect(eventCursorSchema.safeParse({ epoch: '', seq: 0 }).success).toBe(false);
    expect(eventCursorSchema.safeParse({ epoch: 'e1', seq: -1 }).success).toBe(false);
    expect(eventCursorSchema.safeParse({ epoch: 'e1', seq: 1.5 }).success).toBe(false);
    expect(eventCursorSchema.safeParse({ epoch: 'e1' }).success).toBe(false);
  });
});

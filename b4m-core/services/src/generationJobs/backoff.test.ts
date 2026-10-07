import { describe, expect, it } from 'vitest';
import { pollDelaySeconds } from './backoff';

describe('pollDelaySeconds', () => {
  it.each([
    [0, 5],
    [1, 10],
    [2, 20],
    [3, 30],
    [4, 60],
    [50, 60],
    [-1, 5],
  ])('poll %i waits %is', (pollCount, seconds) => {
    expect(pollDelaySeconds(pollCount)).toBe(seconds);
  });
});

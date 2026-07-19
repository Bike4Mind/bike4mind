import { describe, expect, it } from 'vitest';
import { activationToSalience, baseLevelActivation, DEFAULT_ACTIVATION } from './activation';

const DAY = 86_400_000;
const now = Date.parse('2026-07-11T00:00:00.000Z');
const daysAgo = (n: number) => now - n * DAY;

describe('baseLevelActivation', () => {
  it('rewards recency: a recent presentation is more active than an old one', () => {
    const recent = baseLevelActivation([daysAgo(1)], now);
    const old = baseLevelActivation([daysAgo(30)], now);
    expect(recent).toBeGreaterThan(old);
  });

  it('rewards frequency: more presentations sum to more activation', () => {
    const once = baseLevelActivation([daysAgo(7)], now);
    const thrice = baseLevelActivation([daysAgo(7), daysAgo(6), daysAgo(5)], now);
    expect(thrice).toBeGreaterThan(once);
  });

  it('floors elapsed time so a just-now presentation is finite', () => {
    const v = baseLevelActivation([now], now);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('is empty -> negative infinity (no history, no activation)', () => {
    expect(baseLevelActivation([], now)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('activationToSalience', () => {
  it('tiers by the configured thresholds', () => {
    const { hotAbove, warmAbove } = DEFAULT_ACTIVATION;
    expect(activationToSalience(hotAbove + 0.1)).toBe('hot');
    expect(activationToSalience((hotAbove + warmAbove) / 2)).toBe('warm');
    expect(activationToSalience(warmAbove - 0.1)).toBe('cold');
  });

  it('a lone week-old belief is warm; a month-old one is cold', () => {
    expect(activationToSalience(baseLevelActivation([daysAgo(7)], now))).toBe('warm');
    expect(activationToSalience(baseLevelActivation([daysAgo(45)], now))).toBe('cold');
  });
});

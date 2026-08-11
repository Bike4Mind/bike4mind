import { describe, expect, it } from 'vitest';
import {
  activationConfigForKind,
  activationToSalience,
  baseLevelActivation,
  DEFAULT_ACTIVATION,
  LAKE_ACTIVATION,
  type ActivationConfig,
} from './activation';

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

const salience = (presentations: number[], config: ActivationConfig) =>
  activationToSalience(baseLevelActivation(presentations, now, config), config);

describe('activationConfigForKind', () => {
  it('gives a lake the slow-decay config and every other kind the day-scale default', () => {
    expect(activationConfigForKind('lake')).toBe(LAKE_ACTIVATION);
    expect(activationConfigForKind('user')).toBe(DEFAULT_ACTIVATION);
    expect(activationConfigForKind('agent')).toBe(DEFAULT_ACTIVATION);
    expect(activationConfigForKind('org')).toBe(DEFAULT_ACTIVATION);
    expect(activationConfigForKind('system')).toBe(DEFAULT_ACTIVATION);
  });
});

// Flaw 1 from the eval: on the day-scale default, a lake's months-old reference facts all floor to
// cold, so salience is inert. The lake config must keep them alive and let corroboration rank them.
describe('lake activation keeps months-old reference facts from flooring to cold', () => {
  it('a single 3-month-old belief is COLD on the chat default but WARM for a lake', () => {
    const threeMonths = [daysAgo(90)];
    expect(salience(threeMonths, DEFAULT_ACTIVATION)).toBe('cold');
    expect(salience(threeMonths, LAKE_ACTIVATION)).toBe('warm');
  });

  it('a single year-old belief stays WARM for a lake (the chat default would be cold)', () => {
    const aYear = [daysAgo(365)];
    expect(salience(aYear, DEFAULT_ACTIVATION)).toBe('cold');
    expect(salience(aYear, LAKE_ACTIVATION)).toBe('warm');
  });

  it('corroboration lifts a lake belief to HOT - a fact asserted by several articles a year out', () => {
    const corroborated = [daysAgo(365), daysAgo(360), daysAgo(350)];
    expect(salience(corroborated, LAKE_ACTIVATION)).toBe('hot');
  });
});

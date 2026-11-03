import { describe, expect, it } from 'vitest';
import { funnelStepOf, paidInConversionWindow } from './activationFunnel';

const DAY = 86_400_000;
// Late in the UTC day, so a few hours later is already the next day.
const signupAt = new Date('2026-10-01T22:00:00.000Z');
const dayAfterSignup = (days: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + days * DAY);
const day = (days: number) => dayAfterSignup(days).toISOString().slice(0, 10);

describe('funnelStepOf', () => {
  const stepFor = (activeDays: string[], paid = false) => funnelStepOf({ signupAt, activeDays, paid });

  it('is signed up with no activity in days 0 to 7', () => {
    expect(stepFor([])).toBe('signedUp');
    expect(stepFor([day(8), day(30)])).toBe('signedUp');
    expect(stepFor([day(-1)])).toBe('signedUp');
  });

  it('is a first action with activity on the signup day only', () => {
    expect(stepFor([day(0)])).toBe('firstAction');
  });

  it('came back with activity on days 1 through 7, with or without the signup day', () => {
    expect(stepFor([day(1)])).toBe('cameBack');
    expect(stepFor([day(0), day(7)])).toBe('cameBack');
    expect(stepFor([day(0), day(8)])).toBe('firstAction');
  });

  it('is paid only after coming back, so every step stays a subset of the one before', () => {
    expect(stepFor([day(0), day(3)], true)).toBe('paid');
    expect(stepFor([day(0)], true)).toBe('firstAction');
    expect(stepFor([], true)).toBe('signedUp');
  });
});

describe('paidInConversionWindow', () => {
  it('counts a payment from the signup day through UTC day 30 after it', () => {
    expect(paidInConversionWindow(signupAt, new Date(signupAt.getTime() + 60_000))).toBe(true);
    expect(paidInConversionWindow(signupAt, new Date(dayAfterSignup(30).getTime() + DAY - 1))).toBe(true);
    expect(paidInConversionWindow(signupAt, dayAfterSignup(31))).toBe(false);
  });

  it('never counts a payment dated before the signup day', () => {
    expect(paidInConversionWindow(signupAt, dayAfterSignup(-1))).toBe(false);
  });
});

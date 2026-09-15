import { describe, it, expect } from 'vitest';
import { isRotatedSecretWithinGraceWindow, SECRET_ROTATION_GRACE_HOURS } from './secretRotationGrace';

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

describe('isRotatedSecretWithinGraceWindow', () => {
  it('accepts a rotation within the grace window', () => {
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(1))).toBe(true);
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(SECRET_ROTATION_GRACE_HOURS - 1))).toBe(true);
  });

  // Regression for the always-true bug: a rotation older than the window must be
  // rejected so a rotated-out secret cannot authenticate indefinitely.
  it('rejects a rotation older than the grace window', () => {
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(SECRET_ROTATION_GRACE_HOURS + 1))).toBe(false);
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(SECRET_ROTATION_GRACE_HOURS * 30))).toBe(false);
  });

  it('rejects a rotation at exactly the grace-window boundary', () => {
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(SECRET_ROTATION_GRACE_HOURS))).toBe(false);
  });

  it('rejects when there is no recorded rotation', () => {
    expect(isRotatedSecretWithinGraceWindow(undefined)).toBe(false);
    expect(isRotatedSecretWithinGraceWindow(null)).toBe(false);
  });

  it('accepts an ISO-string timestamp within the window', () => {
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(2).toISOString())).toBe(true);
  });

  // dayjs on an unparseable string resolves to Invalid Date, whose isAfter comparisons
  // are always false - fails closed rather than silently trusting the rotation.
  it('rejects an unparseable timestamp (fails closed)', () => {
    expect(isRotatedSecretWithinGraceWindow('not-a-date')).toBe(false);
  });

  // Not expected operationally (rotatedAt is always set to "now"), but documents that the
  // recency check alone doesn't reject a future timestamp - it's still "after now - grace".
  it('accepts a future-dated rotation timestamp', () => {
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(-1))).toBe(true);
  });
});

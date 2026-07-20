import { describe, it, expect } from 'vitest';
import { isRotatedSecretWithinGraceWindow } from './secretRotationGrace';

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

describe('isRotatedSecretWithinGraceWindow', () => {
  it('accepts a rotation within the last 24h', () => {
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(1))).toBe(true);
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(23))).toBe(true);
  });

  // Regression for the always-true bug: a rotation older than the window must be
  // rejected so a rotated-out secret cannot authenticate indefinitely.
  it('rejects a rotation older than 24h', () => {
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(25))).toBe(false);
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(24 * 30))).toBe(false);
  });

  it('rejects when there is no recorded rotation', () => {
    expect(isRotatedSecretWithinGraceWindow(undefined)).toBe(false);
    expect(isRotatedSecretWithinGraceWindow(null)).toBe(false);
  });

  it('accepts an ISO-string timestamp within the window', () => {
    expect(isRotatedSecretWithinGraceWindow(hoursAgo(2).toISOString())).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { commitUrl, formatDelta, formatDuration, formatTestDuration, formatTime, stateLabel } from './format';

describe('format', () => {
  it('formats durations like the spec mock', () => {
    expect(formatDuration(252_000)).toBe('4m12s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(3_720_000)).toBe('1h02m');
  });
  it('shows only the time for today and adds the date otherwise', () => {
    const now = new Date(2026, 8, 28, 12, 0);
    expect(formatTime(new Date(2026, 8, 28, 9, 14).toISOString(), now)).toBe('09:14');
    expect(formatTime(new Date(2026, 8, 27, 9, 14).toISOString(), now)).toMatch(/27.*09:14/);
  });
  it('labels a state key', () => {
    expect(stateLabel({ suite: 'Core', env: 'staging' })).toBe('Core . staging');
    expect(stateLabel({ suite: 'Core', env: 'staging', tenant: 'tenant-a' })).toBe('Core . staging (tenant-a)');
  });
  it('formats test-scale durations', () => {
    expect(formatTestDuration(640)).toBe('640ms');
    expect(formatTestDuration(1234)).toBe('1.2s');
    expect(formatTestDuration(9999)).toBe('10s');
    expect(formatTestDuration(45_000)).toBe('45s');
  });
  it('signs a delta', () => {
    expect(formatDelta(40_000, formatDuration)).toBe('+40s');
    expect(formatDelta(-65_000, formatDuration)).toBe('-1m05s');
    expect(formatDelta(0, formatDuration)).toBe('+0s');
    expect(formatDelta(-800, formatTestDuration)).toBe('-800ms');
  });
  it('derives the commit url from a GitHub Actions run url only', () => {
    const run = 'https://github.com/example/repo/actions/runs/123';
    expect(commitUrl(run, 'abc1234')).toBe('https://github.com/example/repo/commit/abc1234');
    expect(commitUrl(run, '')).toBeUndefined();
    expect(commitUrl('https://slack.example/archives/C1/p1', 'abc1234')).toBeUndefined();
    expect(commitUrl('https://evil.example/https://github.com/example/repo/actions/runs/1', 'abc1234')).toBeUndefined();
  });
});

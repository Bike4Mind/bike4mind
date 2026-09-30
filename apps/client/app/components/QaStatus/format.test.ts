import { describe, it, expect } from 'vitest';
import { formatDuration, formatTime, stateLabel } from './format';

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
});

import { describe, expect, it } from 'vitest';
import { formatLastChecked, integrationStatusView } from '../integrationStatus';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

describe('formatLastChecked', () => {
  it('says never when there is no check', () => {
    expect(formatLastChecked(null, NOW)).toBe('never');
  });

  it('says never for an unreadable timestamp', () => {
    expect(formatLastChecked('not a date', NOW)).toBe('never');
  });

  it('formats seconds, minutes, hours and days', () => {
    expect(formatLastChecked('2026-11-09T11:59:18.000Z', NOW)).toBe('42s ago');
    expect(formatLastChecked('2026-11-09T11:55:00.000Z', NOW)).toBe('5m ago');
    expect(formatLastChecked('2026-11-09T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(formatLastChecked('2026-11-07T11:00:00.000Z', NOW)).toBe('2d ago');
  });

  it('does not go negative when the check is slightly in the future', () => {
    expect(formatLastChecked('2026-11-09T12:00:05.000Z', NOW)).toBe('0s ago');
  });
});

describe('integrationStatusView', () => {
  it('maps each status to its soft tone', () => {
    const checked = '2026-11-09T11:00:00.000Z';
    expect(integrationStatusView({ status: 'healthy', lastCheckedAt: checked })).toEqual({
      tone: 'good',
      label: 'Healthy',
    });
    expect(integrationStatusView({ status: 'degraded', lastCheckedAt: checked })).toEqual({
      tone: 'warn',
      label: 'Degraded',
    });
    expect(integrationStatusView({ status: 'unhealthy', lastCheckedAt: checked })).toEqual({
      tone: 'bad',
      label: 'Down',
    });
  });

  it('shows a never-checked integration as not checked, not down', () => {
    expect(integrationStatusView({ status: 'no_data', lastCheckedAt: null })).toEqual({
      tone: 'neutral',
      label: 'Not checked',
    });
  });

  it('treats an unreadable timestamp as not checked, matching formatLastChecked', () => {
    expect(integrationStatusView({ status: 'unhealthy', lastCheckedAt: 'not a date' })).toEqual({
      tone: 'neutral',
      label: 'Not checked',
    });
  });
});

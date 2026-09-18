import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveReportWindow, resolveInstantWindow, MAX_WINDOW_DAYS } from '../orgFeedbackWindow';

/**
 * Asserting on `toISOString()` is the point: these are the only assertions that would catch a
 * regression from `dayjs.utc(...)` back to plain `dayjs(...)`, since a local-time round only
 * disagrees with the aggregate's UTC grouping when the process runs under a non-UTC `TZ`.
 */
describe('resolveReportWindow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rounds an explicit from/to out to whole UTC days regardless of local TZ', () => {
    const { from, to } = resolveReportWindow({ from: '2026-09-18', to: '2026-09-18' });

    expect(from.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-18T23:59:59.999Z');
  });

  it('spans exactly the default trailing window ending today, in UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:00:00.000Z'));

    const { from, to } = resolveReportWindow({});

    expect(to.toISOString()).toBe('2026-09-18T23:59:59.999Z');
    expect(from.toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });

  it('rejects an inverted range', () => {
    expect(() => resolveReportWindow({ from: '2026-09-20', to: '2026-09-18' })).toThrow(/from must not be after to/);
  });

  it('rejects a range over the ceiling', () => {
    expect(() => resolveReportWindow({ from: '2020-01-01', to: `2026-01-01` })).toThrow(
      new RegExp(`${MAX_WINDOW_DAYS} days`)
    );
  });
});

describe('resolveInstantWindow', () => {
  it('rounds identical instants out to the whole UTC day rather than a zero-width window', () => {
    const { from, to } = resolveInstantWindow('2026-09-18T12:00:00.000Z', '2026-09-18T12:00:00.000Z');

    expect(from.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-18T23:59:59.999Z');
  });

  it('maps UI-shaped day-boundary instants to themselves', () => {
    const { from, to } = resolveInstantWindow('2026-09-18T00:00:00.000Z', '2026-09-18T23:59:59.999Z');

    expect(from.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-18T23:59:59.999Z');
  });

  it('rejects an inverted range', () => {
    expect(() => resolveInstantWindow('2026-09-20T00:00:00.000Z', '2026-09-18T00:00:00.000Z')).toThrow(
      /from must not be after to/
    );
  });

  it('rejects a range over the ceiling', () => {
    expect(() => resolveInstantWindow('2020-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toThrow(
      new RegExp(`${MAX_WINDOW_DAYS} days`)
    );
  });
});

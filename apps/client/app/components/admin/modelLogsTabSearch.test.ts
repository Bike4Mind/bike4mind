import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MODEL_LOGS_MAX_PAGE } from '@client/shared/modelLogs';
import { DEFAULT_PRESET_DAYS, getActivePreset } from './EventMetrics/UserActivity/dateRange';
import {
  MODEL_LOGS_SEARCH_PARSERS,
  defaultModelLogsView,
  modelLogsViewFromSearch,
  modelLogsViewToSearch,
  type ModelLogsView,
} from './modelLogsTabSearch';

const parsers = MODEL_LOGS_SEARCH_PARSERS;

const withoutUndefined = (search: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined));

describe('model logs params', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T12:00:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([MODEL_LOGS_MAX_PAGE, String(MODEL_LOGS_MAX_PAGE)])('accepts the final allowed page %j', value => {
    expect(parsers.modelLogsPage(value)).toBe(MODEL_LOGS_MAX_PAGE);
    expect(modelLogsViewFromSearch({ modelLogsPage: value }).page).toBe(MODEL_LOGS_MAX_PAGE);
    expect(modelLogsViewToSearch({ ...defaultModelLogsView(), page: MODEL_LOGS_MAX_PAGE }).modelLogsPage).toBe(
      MODEL_LOGS_MAX_PAGE
    );
  });

  it.each([MODEL_LOGS_MAX_PAGE + 1, String(MODEL_LOGS_MAX_PAGE + 1), Number.MAX_SAFE_INTEGER, '1e100'])(
    'rejects an out-of-range page %j',
    value => {
      expect(parsers.modelLogsPage(value)).toBeUndefined();
      expect(modelLogsViewFromSearch({ modelLogsPage: value }).page).toBe(1);
      expect(modelLogsViewToSearch({ ...defaultModelLogsView(), page: Number(value) }).modelLogsPage).toBeUndefined();
    }
  );

  describe('dates', () => {
    it('accepts a calendar date', () => {
      expect(parsers.modelLogsFrom('2026-02-28')).toBe('2026-02-28');
      expect(parsers.modelLogsTo('2024-02-29')).toBe('2024-02-29');
    });

    it.each([['2026-02-30'], ['2026-13-01'], ['2026-1-01'], ['2026-10-21T00:00:00Z'], ['yesterday'], [''], [20261021]])(
      'rejects %j',
      value => {
        expect(parsers.modelLogsFrom(value)).toBeUndefined();
      }
    );
  });

  it.each([
    ['modelLogsLimit', 25, 25],
    ['modelLogsLimit', '50', 50],
    ['modelLogsLimit', 20, undefined],
    ['modelLogsPage', 3, 3],
    ['modelLogsPage', 0, undefined],
    ['modelLogsPage', '1.5', undefined],
    ['modelLogsModel', 'claude-3-opus', 'claude-3-opus'],
    ['modelLogsModel', 'all', undefined],
    ['modelLogsModel', 'some-other-model', undefined],
  ] as const)('parses %s=%j as %j', (key, value, expected) => {
    expect(parsers[key](value)).toBe(expected);
  });

  describe('modelLogsViewFromSearch', () => {
    it('is the rolling last 7 days for a bare URL', () => {
      expect(modelLogsViewFromSearch({})).toEqual({
        page: 1,
        limit: 10,
        startDate: '2026-10-15',
        endDate: '2026-10-21',
        model: undefined,
      });
    });

    it('defaults to exactly the date filter default preset, so it shows as selected', () => {
      expect(getActivePreset(defaultModelLogsView())).toBe(DEFAULT_PRESET_DAYS);
    });

    it('reads a linked range', () => {
      expect(modelLogsViewFromSearch({ modelLogsFrom: '2026-09-01', modelLogsTo: '2026-09-30' })).toMatchObject({
        startDate: '2026-09-01',
        endDate: '2026-09-30',
      });
    });

    it('fills a missing end of the range from the default', () => {
      expect(modelLogsViewFromSearch({ modelLogsFrom: '2026-10-01' })).toMatchObject({
        startDate: '2026-10-01',
        endDate: '2026-10-21',
      });
    });

    it('keeps a range that ends before it starts, so a partly typed end year survives', () => {
      expect(modelLogsViewFromSearch({ modelLogsFrom: '2026-09-30', modelLogsTo: '0002-10-21' })).toMatchObject({
        startDate: '2026-09-30',
        endDate: '0002-10-21',
      });
    });

    it('falls back to the default range when only an invalid date is given', () => {
      expect(modelLogsViewFromSearch({ modelLogsFrom: 'garbage', modelLogsTo: '2026-02-31' })).toMatchObject({
        startDate: '2026-10-15',
        endDate: '2026-10-21',
      });
    });
  });

  describe('modelLogsViewToSearch', () => {
    it('omits every default', () => {
      expect(withoutUndefined(modelLogsViewToSearch(defaultModelLogsView()))).toEqual({});
    });

    it('writes a changed range as a pair', () => {
      expect(withoutUndefined(modelLogsViewToSearch({ ...defaultModelLogsView(), startDate: '2026-10-01' }))).toEqual({
        modelLogsFrom: '2026-10-01',
        modelLogsTo: '2026-10-21',
      });
    });

    it('round-trips a full view', () => {
      const view: ModelLogsView = {
        page: 3,
        limit: 50,
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        model: 'gpt-4',
      };
      const search = modelLogsViewToSearch(view);

      expect(search).toEqual({
        modelLogsPage: 3,
        modelLogsLimit: 50,
        modelLogsFrom: '2026-09-01',
        modelLogsTo: '2026-09-30',
        modelLogsModel: 'gpt-4',
      });
      expect(modelLogsViewFromSearch(search)).toEqual(view);
    });
  });
});

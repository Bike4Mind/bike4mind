import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { EMPTY_FILTER_STATE, filterStateToQuery } from './HistoryFilters';

describe('filterStateToQuery', () => {
  it('returns an empty filter set when the form is untouched', () => {
    expect(filterStateToQuery(EMPTY_FILTER_STATE)).toEqual({});
  });

  it('expands the "Running" pill into the running + continuing pair', () => {
    // `continuing` is a transient internal state hidden from the UI; selecting
    // "Running" should match both so users actually see in-flight executions
    // regardless of which side of the handoff they're on right now.
    const result = filterStateToQuery({ ...EMPTY_FILTER_STATE, statuses: ['running'] });
    expect(result.status).toEqual(['running', 'continuing']);
  });

  it('passes other statuses through verbatim', () => {
    const result = filterStateToQuery({
      ...EMPTY_FILTER_STATE,
      statuses: ['completed', 'failed'],
    });
    expect(result.status).toEqual(['completed', 'failed']);
  });

  it('parses numeric credit bounds and ignores blank inputs', () => {
    expect(filterStateToQuery({ ...EMPTY_FILTER_STATE, minCredits: '10', maxCredits: '100' })).toMatchObject({
      minCredits: 10,
      maxCredits: 100,
    });

    expect(filterStateToQuery({ ...EMPTY_FILTER_STATE, minCredits: '', maxCredits: '50' })).toMatchObject({
      maxCredits: 50,
    });

    const result = filterStateToQuery({ ...EMPTY_FILTER_STATE, minCredits: '', maxCredits: '' });
    expect(result).not.toHaveProperty('minCredits');
    expect(result).not.toHaveProperty('maxCredits');
  });

  it('converts date presets into an ISO `from` boundary', () => {
    const before = dayjs();
    const result = filterStateToQuery({ ...EMPTY_FILTER_STATE, datePreset: '24h' });
    const after = dayjs();

    expect(result.from).toBeDefined();
    const from = dayjs(result.from);
    // The `from` boundary should land within `now - 24h`, where `now` is
    // somewhere between `before` and `after`. ±1s on either side covers slow
    // CI without making the assertion meaningless.
    const upper = before.subtract(24, 'hour').add(1, 'second');
    const lower = after.subtract(24, 'hour').subtract(1, 'second');
    expect(from.isBefore(upper)).toBe(true);
    expect(from.isAfter(lower)).toBe(true);
  });

  it('omits `from` when the preset is "all"', () => {
    const result = filterStateToQuery({ ...EMPTY_FILTER_STATE, datePreset: 'all' });
    expect(result).not.toHaveProperty('from');
  });

  it('trims whitespace from the model input', () => {
    expect(filterStateToQuery({ ...EMPTY_FILTER_STATE, model: '  claude-opus  ' })).toMatchObject({
      model: ['claude-opus'],
    });
    expect(filterStateToQuery({ ...EMPTY_FILTER_STATE, model: '   ' })).not.toHaveProperty('model');
  });
});

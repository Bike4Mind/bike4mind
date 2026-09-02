import { describe, expect, it } from 'vitest';
import { BASELINE_CONFIG, formatConfig, formatSweepTable, parseConfigs } from './sweep';
import { aggregate, scoreQuestion } from './metrics';

describe('parseConfigs', () => {
  it('parses a sweep of tokenBudget:minRelevancePct points', () => {
    expect(parseConfigs('0:0,4000:0,4000:60')).toEqual([
      { tokenBudget: 0, minRelevancePct: 0 },
      { tokenBudget: 4000, minRelevancePct: 0 },
      { tokenBudget: 4000, minRelevancePct: 60 },
    ]);
  });

  it('tolerates whitespace and trailing separators', () => {
    expect(parseConfigs(' 0:0 , 8000:50 ,')).toEqual([
      { tokenBudget: 0, minRelevancePct: 0 },
      { tokenBudget: 8000, minRelevancePct: 50 },
    ]);
  });

  it('rejects a malformed point instead of silently dropping it', () => {
    // A dropped row would leave a results table that looks complete and is missing what was asked for.
    expect(() => parseConfigs('0:0,notanumber:0')).toThrow(/token budget/i);
    expect(() => parseConfigs('4000')).toThrow(/relevance floor/i);
    expect(() => parseConfigs('-1:0')).toThrow(/token budget/i);
    expect(() => parseConfigs('4000:1.5')).toThrow(/relevance floor/i);
  });

  it('rejects a relevance floor outside 0-100, the unit the setting stores', () => {
    expect(() => parseConfigs('0:101')).toThrow(/relevance floor/i);
    expect(() => parseConfigs('0:-5')).toThrow(/relevance floor/i);
  });

  it('rejects an empty spec', () => {
    expect(() => parseConfigs('')).toThrow(/no configurations/i);
    expect(() => parseConfigs('  ,  ')).toThrow(/no configurations/i);
  });

  it('rejects a duplicated point, which would print two rows differing only by noise', () => {
    expect(() => parseConfigs('4000:60,4000:60')).toThrow(/duplicate/i);
  });

  it('accepts the shipped baseline', () => {
    expect(parseConfigs('0:0')).toEqual([BASELINE_CONFIG]);
  });
});

describe('formatConfig', () => {
  it('labels a point readably', () => {
    expect(formatConfig({ tokenBudget: 4000, minRelevancePct: 60 })).toBe('budget=4000 floor=60%');
  });
});

describe('formatSweepTable', () => {
  const row = (tokenBudget: number, minRelevancePct: number) => ({
    tokenBudget,
    minRelevancePct,
    aggregate: aggregate([
      scoreQuestion(['a'], new Set(['a', 'b'])), // positive, recall 0.5
      scoreQuestion(['x'], new Set()), // negative, served something
    ]),
  });

  it('renders one row per configuration under a Markdown header', () => {
    const table = formatSweepTable([row(0, 0), row(4000, 60)]);
    const lines = table.split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    expect(lines[0]).toContain('false-positive rate');
  });

  it('prints a disabled knob as "off" rather than 0, which reads as a real budget', () => {
    const lines = formatSweepTable([row(0, 0)]).split('\n');
    expect(lines[2]).toContain('| off | off |');
  });

  it('shows configured values with their units', () => {
    const lines = formatSweepTable([row(4000, 60)]).split('\n');
    expect(lines[2]).toContain('| 4000 | 60% |');
  });

  it('reports the metrics that can independently change the decision', () => {
    const lines = formatSweepTable([row(0, 0)]).split('\n');
    expect(lines[2]).toContain('50.0%'); // recall of the positive
    expect(lines[2]).toContain('100.0%'); // falsePositiveRate: the one negative served something
  });

  it('renders a header even with no rows, so an empty run is visibly empty', () => {
    expect(formatSweepTable([]).split('\n')).toHaveLength(2);
  });
});

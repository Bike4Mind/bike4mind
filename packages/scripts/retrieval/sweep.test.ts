import { describe, expect, it } from 'vitest';
import { KB_SEARCH_DEFAULT_RESULTS_DEFAULT } from '@bike4mind/common';
import { BASELINE_CONFIG, formatConfig, formatSweepTable, parseConfigs } from './sweep';
import { aggregate, scoreQuestion } from './metrics';
import { aggregateClaimAudits } from './claimAudit';

describe('parseConfigs', () => {
  it('parses a sweep of tokenBudget:minRelevancePct:defaultResults points', () => {
    expect(parseConfigs('0:0:5,4000:0:10,4000:60:10')).toEqual([
      { tokenBudget: 0, minRelevancePct: 0, defaultResults: 5 },
      { tokenBudget: 4000, minRelevancePct: 0, defaultResults: 10 },
      { tokenBudget: 4000, minRelevancePct: 60, defaultResults: 10 },
    ]);
  });

  it('tolerates whitespace and trailing separators', () => {
    expect(parseConfigs(' 0:0:5 , 8000:50:8 ,')).toEqual([
      { tokenBudget: 0, minRelevancePct: 0, defaultResults: 5 },
      { tokenBudget: 8000, minRelevancePct: 50, defaultResults: 8 },
    ]);
  });

  it('rejects a malformed point instead of silently dropping it', () => {
    // A dropped row would leave a results table that looks complete and is missing what was asked for.
    expect(() => parseConfigs('0:0:5,notanumber:0:5')).toThrow(/token budget/i);
    expect(() => parseConfigs('4000')).toThrow(/exactly/i);
    expect(() => parseConfigs('-1:0:5')).toThrow(/token budget/i);
    expect(() => parseConfigs('4000:1.5:5')).toThrow(/relevance floor/i);
    expect(() => parseConfigs('4000:60:2.5')).toThrow(/passage default/i);
  });

  it('requires exactly three components, since a missing one parses as a silent 0', () => {
    // Number('') is 0 and Number.isInteger(0) is true, so without the arity and emptiness checks
    // "4000:60:" would run a results-0 row under the name of a value someone asked for, and
    // "4000:70:80:90" would drop its fourth segment. Both give a table that looks like the
    // requested sweep and is not.
    expect(() => parseConfigs('4000:60:')).toThrow(/passage default/i);
    expect(() => parseConfigs('4000::5')).toThrow(/relevance floor/i);
    expect(() => parseConfigs(':70:5')).toThrow(/token budget/i);
    expect(() => parseConfigs('4000:70:80:90')).toThrow(/exactly/i);
  });

  it('refuses a two-component entry rather than supplying the passage default itself', () => {
    // The knob is swept because its value was the ACTIVE bound while nobody stated it, so an entry
    // that declines to state it is the exact input this sweep exists to refuse. Defaulting here
    // would reintroduce the unstated bound the measurement is meant to expose.
    expect(() => parseConfigs('0:0')).toThrow(/exactly/i);
    expect(() => parseConfigs('4000:60')).toThrow(/tokenBudget:minRelevancePct:defaultResults/);
  });

  it('rejects a token budget above the ceiling the setting itself declares', () => {
    // kbSearchResultTokenBudget caps at 20000, enforced only by the settings API's schema.parse -
    // which this script bypasses by writing the model directly. A larger value is a row no admin
    // could ever deploy, and is measurement-identical to 20000 anyway since the passage ceiling
    // binds first above it.
    expect(() => parseConfigs('50000:0:5')).toThrow(/ceiling/i);
    expect(parseConfigs('20000:0:5')).toEqual([{ tokenBudget: 20_000, minRelevancePct: 0, defaultResults: 5 }]);
  });

  it('rejects a relevance floor outside 0-100, the unit the setting stores', () => {
    expect(() => parseConfigs('0:101:5')).toThrow(/relevance floor/i);
    expect(() => parseConfigs('0:-5:5')).toThrow(/relevance floor/i);
  });

  it('rejects a passage default outside the 1-10 bounds the setting declares', () => {
    // 10 is also the tool's hard KB_SEARCH_MAX_RESULTS ceiling, so an 11 would clamp back to 10 and
    // print a row measuring 10 under another number's name. 0 is a disabled search, not a narrow one.
    expect(() => parseConfigs('0:0:11')).toThrow(/passage default/i);
    expect(() => parseConfigs('0:0:0')).toThrow(/passage default/i);
    expect(() => parseConfigs('0:0:-1')).toThrow(/passage default/i);
    expect(parseConfigs('0:0:10')).toEqual([{ tokenBudget: 0, minRelevancePct: 0, defaultResults: 10 }]);
    expect(parseConfigs('0:0:1')).toEqual([{ tokenBudget: 0, minRelevancePct: 0, defaultResults: 1 }]);
  });

  it('rejects an empty spec', () => {
    expect(() => parseConfigs('')).toThrow(/no configurations/i);
    expect(() => parseConfigs('  ,  ')).toThrow(/no configurations/i);
  });

  it('rejects a duplicated point, which would print two rows differing only by noise', () => {
    expect(() => parseConfigs('4000:60:5,4000:60:5')).toThrow(/duplicate/i);
  });

  it('does not treat two points differing only in passage default as duplicates', () => {
    // The dedupe key is formatConfig, so it has to carry the third knob or the sweep that motivated
    // adding it - one budget against several passage defaults - would be rejected as a duplicate.
    expect(parseConfigs('4000:60:5,4000:60:10')).toHaveLength(2);
  });

  it('accepts the shipped baseline', () => {
    expect(parseConfigs(`0:0:${KB_SEARCH_DEFAULT_RESULTS_DEFAULT}`)).toEqual([BASELINE_CONFIG]);
  });
});

describe('BASELINE_CONFIG', () => {
  it('tracks the shipped passage default rather than restating it', () => {
    // This ticket changes the shipped defaults; a restated 5 here would leave the baseline row
    // naming a value the product no longer uses.
    expect(BASELINE_CONFIG.defaultResults).toBe(KB_SEARCH_DEFAULT_RESULTS_DEFAULT);
  });
});

describe('formatConfig', () => {
  it('labels a point readably', () => {
    expect(formatConfig({ tokenBudget: 4000, minRelevancePct: 60, defaultResults: 10 })).toBe(
      'budget=4000 floor=60% results=10'
    );
  });
});

describe('formatSweepTable', () => {
  const row = (tokenBudget: number, minRelevancePct: number, defaultResults = 5) => ({
    tokenBudget,
    minRelevancePct,
    defaultResults,
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

  it('prints a disabled budget knob as "off" rather than 0, which reads as a real budget', () => {
    const lines = formatSweepTable([row(0, 0)]).split('\n');
    expect(lines[2]).toContain('| off | off |');
  });

  it('shows configured values with their units', () => {
    const lines = formatSweepTable([row(4000, 60)]).split('\n');
    expect(lines[2]).toContain('| 4000 | 60% |');
  });

  it('prints the passage default as a number, never "off"', () => {
    // 1 is the setting's minimum, so there is no disabled value to render - and leaving the column
    // blank at the shipped 5 is what made the baseline's 3.1 docs/q unreadable in the first place.
    expect(formatSweepTable([row(0, 0, 5)]).split('\n')[2]).toContain('| off | off | 5 |');
    expect(formatSweepTable([row(0, 0, 1)]).split('\n')[2]).toContain('| off | off | 1 |');
  });

  it('separates the header columns so results lands between floor and recall', () => {
    const [header, separator] = formatSweepTable([row(0, 0)]).split('\n');
    expect(header).toContain('| floor | results | recall |');
    // A separator short by one cell renders the whole table as plain text in Markdown.
    expect(separator.split('|').length).toBe(header.split('|').length);
  });

  it('reports the metrics that can independently change the decision', () => {
    const lines = formatSweepTable([row(0, 0)]).split('\n');
    expect(lines[2]).toContain('50.0%'); // recall of the positive
    expect(lines[2]).toContain('100.0%'); // falsePositiveRate: the one negative served something
  });

  it('prints the precision denominator, which moves with the configuration', () => {
    // Precision skips positives that served nothing, so its `n` shrinks as a floor bites. Without
    // the count in the cell, a precision rising on a shrinking sample reads as an improvement.
    const lines = formatSweepTable([row(0, 0)]).split('\n');
    expect(lines[2]).toContain('(n=1)');
  });

  it('prints n/a rather than 0.0% when no positive served anything', () => {
    const emptied = {
      tokenBudget: 4000,
      minRelevancePct: 90,
      defaultResults: 5,
      aggregate: aggregate([scoreQuestion([], new Set(['a']))]),
    };
    const lines = formatSweepTable([emptied]).split('\n');
    // mean([]) is 0, and a bare 0.0% here would read as a measured collapse rather than an
    // absence of anything to measure.
    expect(lines[2]).toContain('n/a (n=0)');
  });

  it('renders a header even with no rows, so an empty run is visibly empty', () => {
    expect(formatSweepTable([]).split('\n')).toHaveLength(2);
  });
});

describe('formatSweepTable claim columns', () => {
  const base = (claims?: ReturnType<typeof aggregateClaimAudits>) => ({
    tokenBudget: 0,
    minRelevancePct: 0,
    defaultResults: 5,
    aggregate: aggregate([scoreQuestion(['a'], new Set(['a', 'b']))]),
    claims,
  });

  it('omits the claim columns entirely when the run did not measure them', () => {
    const [header, separator] = formatSweepTable([base()]).split('\n');
    expect(header).not.toContain('unverifiable');
    // A header promising columns no row can fill reads as a measurement that came back empty.
    expect(separator.split('|').length).toBe(header.split('|').length);
  });

  it('adds the rate beside the two columns that are its missing denominator', () => {
    const claims = aggregateClaimAudits([
      { kind: 'scored', verdicts: [{ claim: 'c', verdict: 'unsupported' }] },
      { kind: 'skipped', reason: 'abstained' },
      { kind: 'skipped', reason: 'served-nothing' },
      { kind: 'skipped', reason: 'served-nothing' },
    ]);
    const [header, separator, row] = formatSweepTable([base(claims)]).split('\n');
    expect(header).toContain('| unverifiable | abstained | served nothing |');
    expect(separator.split('|').length).toBe(header.split('|').length);
    // A configuration can post a fine rate by answering almost nothing; those counts are where
    // that shows, so they must travel with the rate rather than only in the JSON.
    expect(row).toContain('100.0% (n=1)');
    expect(row.trimEnd().endsWith('| 1 | 2 |')).toBe(true);
  });

  it('prints n/a rather than 0.0% when no claim was scored', () => {
    // 0.0% unverifiable is the most flattering number in the table and must never be printed for
    // an absence of measurement.
    const emptied = aggregateClaimAudits([{ kind: 'skipped', reason: 'served-nothing' }]);
    expect(formatSweepTable([base(emptied)]).split('\n')[2]).toContain('n/a (n=0)');
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LakeRagKind } from './bank';
import {
  buildLakeRagReport,
  compareLakeRagReports,
  formatLakeRagReport,
  LAKE_RAG_NOISE_BAND,
  type LakeRagReport,
} from './report';
import { readLakeRagReport, writeLakeRagReport } from './reportFile';
import type { LakeRagArm, LakeRagTurn } from './run';

function turn(arm: LakeRagArm, kind: LakeRagKind, passed: boolean, ran = false): LakeRagTurn {
  return {
    arm,
    kind,
    rowId: `${arm}-${kind}`,
    sample: 0,
    grade: { passed, reason: '', kind, answer: passed, staleRejected: true, citation: { status: 'not-applicable' } },
    retrieval: { ran, via: ran ? 'citables' : 'none' },
  };
}

const META = { model: 'm', samples: 1, generatedAt: '2026-01-01T00:00:00.000Z' };

describe('buildLakeRagReport', () => {
  const turns = [
    turn('lake', 'fact', true, true),
    turn('lake', 'fact', true, true),
    turn('lake', 'stale-same-name', false, true),
    turn('lake', 'absent', true, false),
    turn('multi-lake', 'fact', true, true),
    turn('multi-lake', 'stale-same-name', false, true),
    turn('multi-lake', 'absent', false, false),
    turn('multi-lake', 'stale-different-name', false, false),
    turn('plain', 'fact', true),
    turn('plain', 'absent', false),
  ];
  const report = buildLakeRagReport(turns, META);

  it('computes pass and retrieval rates per arm', () => {
    expect(report.arms.lake?.pass).toEqual({ passed: 3, total: 4, rate: 0.75 });
    expect(report.arms.lake?.retrieval).toEqual({ passed: 3, total: 4, rate: 0.75 });
    expect(report.arms['multi-lake']?.pass.rate).toBe(0.25);
  });

  it('breaks the pass rate down by kind, null-rated for a kind with no rows', () => {
    expect(report.arms.lake?.byKind.fact).toEqual({ passed: 2, total: 2, rate: 1 });
    expect(report.arms.lake?.byKind['stale-same-name']).toEqual({ passed: 0, total: 1, rate: 0 });
    expect(report.arms.lake?.byKind['stale-different-name']).toEqual({ passed: 0, total: 0, rate: null });
  });

  it('reports plain-arm absent as n/a and leaves it out of the plain pass rate, but not its retrieval rate', () => {
    expect(report.arms.plain?.byKind.absent).toBeNull();
    expect(report.arms.plain?.pass).toEqual({ passed: 1, total: 1, rate: 1 });
    expect(report.arms.plain?.retrieval.total).toBe(2);
  });

  it('reports the multi-lake drop as lake minus multi-lake', () => {
    expect(report.multiLakeDrop).toBeCloseTo(0.5);
  });

  it('omits an arm that did not run and leaves the drop null without both lake arms', () => {
    const lakeOnly = buildLakeRagReport([turn('lake', 'fact', true)], META);
    expect(Object.keys(lakeOnly.arms)).toEqual(['lake']);
    expect(lakeOnly.multiLakeDrop).toBeNull();
  });

  it('round-trips through the JSON file, overwriting rather than appending', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lakerag-')), 'nested', 'report.json');
    writeLakeRagReport(path, buildLakeRagReport([turn('lake', 'fact', false)], META));
    writeLakeRagReport(path, report);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report);
    expect(readLakeRagReport(path)).toEqual(report);
  });

  it('names the path when the baseline is truncated JSON, keeping the parse error as the cause', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lakerag-')), 'cut.json');
    writeFileSync(path, '{"arms":');
    const err = (() => {
      try {
        readLakeRagReport(path);
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(String(err)).toContain(`${path} is not a lake RAG eval report`);
    expect(err?.cause).toBeInstanceOf(SyntaxError);
  });

  it('reports a missing baseline as a read error, not a malformed report', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lakerag-')), 'absent.json');
    const err = (() => {
      try {
        readLakeRagReport(path);
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(String(err)).toMatch(/ENOENT/);
    expect(String(err)).not.toContain('is not a lake RAG eval report');
  });

  it.each([
    ['no arms', { multiLakeDrop: null }, /missing arms/],
    ['a non-numeric drop', { arms: {}, multiLakeDrop: 'x' }, /multiLakeDrop/],
    ['an arm without rates', { arms: { lake: { pass: {} } }, multiLakeDrop: null }, /arm lake lacks/],
  ])('rejects a baseline with %s by name', (_label, body, error) => {
    const path = join(mkdtempSync(join(tmpdir(), 'lakerag-')), 'bad.json');
    writeFileSync(path, JSON.stringify(body));
    expect(() => readLakeRagReport(path)).toThrow(error);
  });
});

describe('compareLakeRagReports', () => {
  type Rates = { pass: number; retrieval: number };
  function shaped(rates: Partial<Record<LakeRagArm, Rates>>, multiLakeDrop: number | null) {
    const arms: LakeRagReport['arms'] = {};
    for (const [arm, r] of Object.entries(rates) as [LakeRagArm, Rates][]) {
      arms[arm] = {
        pass: { passed: 0, total: 0, rate: r.pass },
        retrieval: { passed: 0, total: 0, rate: r.retrieval },
        byKind: { fact: null, 'stale-same-name': null, 'stale-different-name': null, absent: null },
      };
    }
    return { arms, multiLakeDrop };
  }
  const base = shaped(
    {
      lake: { pass: 0.8, retrieval: 1 },
      'multi-lake': { pass: 0.6, retrieval: 0.95 },
      plain: { pass: 0.3, retrieval: 0 },
    },
    0.2
  );

  it('accepts movement up to exactly the band edge', () => {
    const curr = shaped(
      {
        lake: { pass: 0.7, retrieval: 0.95 },
        'multi-lake': { pass: 0.7, retrieval: 1 },
        plain: { pass: 0.4, retrieval: 0.05 },
      },
      0.1
    );
    const result = compareLakeRagReports(base, curr);
    expect(result.checks.map(c => c.metric)).toEqual([
      'lake.pass',
      'multi-lake.pass',
      'plain.pass',
      'lake.retrieval',
      'multi-lake.retrieval',
      'multiLakeDrop',
    ]);
    expect(result.withinBand).toBe(true);
  });

  it('flags each banded metric that moves past its band', () => {
    const curr = shaped(
      {
        lake: { pass: 0.69, retrieval: 0.94 },
        'multi-lake': { pass: 0.6, retrieval: 0.95 },
        plain: { pass: 0.3, retrieval: 0 },
      },
      0.09
    );
    const result = compareLakeRagReports(base, curr);
    expect(result.withinBand).toBe(false);
    expect(result.checks.filter(c => !c.ok).map(c => c.metric)).toEqual([
      'lake.pass',
      'lake.retrieval',
      'multiLakeDrop',
    ]);
  });

  it('does not band the plain retrieval rate', () => {
    const curr = shaped(
      {
        lake: { pass: 0.8, retrieval: 1 },
        'multi-lake': { pass: 0.6, retrieval: 0.95 },
        plain: { pass: 0.3, retrieval: 0.5 },
      },
      0.2
    );
    const result = compareLakeRagReports(base, curr);
    expect(result.withinBand).toBe(true);
    expect(result.checks.some(c => c.metric === 'plain.retrieval')).toBe(false);
  });

  it('fails an arm present in only one report and skips one absent from both', () => {
    const noMulti = shaped({ lake: { pass: 0.8, retrieval: 1 }, plain: { pass: 0.3, retrieval: 0 } }, null);
    const result = compareLakeRagReports(base, noMulti);
    expect(result.withinBand).toBe(false);
    expect(result.checks.filter(c => !c.ok).map(c => c.metric)).toEqual([
      'multi-lake.pass',
      'multi-lake.retrieval',
      'multiLakeDrop',
    ]);
    expect(compareLakeRagReports(noMulti, noMulti).withinBand).toBe(true);
  });

  it('uses the gate-accepted band by default', () => {
    expect(LAKE_RAG_NOISE_BAND).toEqual({ passRate: 0.1, retrievalRate: 0.05, multiLakeDrop: 0.1 });
  });
});

describe('formatLakeRagReport', () => {
  const report = buildLakeRagReport(
    [
      turn('lake', 'fact', true, true),
      turn('lake', 'stale-same-name', false, true),
      turn('plain', 'fact', true),
      turn('plain', 'absent', false),
    ],
    META
  );

  it('prints each arm, marks plain absent n/a and lists only scored failures', () => {
    const text = formatLakeRagReport(report);
    expect(text).toContain('lake: pass 1/2 (50.0%), retrieval 2/2 (100.0%)');
    expect(text).toContain('plain: pass 1/1 (100.0%)');
    expect(text).toContain('absent n/a');
    expect(text).toContain('multi-lake drop: n/a');
    expect(text).toContain('FAIL lake lake-stale-same-name#0');
    expect(text).not.toContain('FAIL plain');
    expect(text).not.toContain('baseline');
  });

  it('names the metrics outside the band when given a comparison', () => {
    const prev = buildLakeRagReport([turn('lake', 'fact', true, true)], META);
    const text = formatLakeRagReport(report, compareLakeRagReports(prev, report));
    expect(text).toContain('baseline: OUT OF BAND lake.pass 100.0% -> 50.0%');
    expect(formatLakeRagReport(report, compareLakeRagReports(report, report))).toContain(
      'baseline: within the noise band'
    );
  });
});

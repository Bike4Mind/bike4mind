import { describe, expect, it } from 'vitest';
import { buildAdminEvalReport, formatAdminEvalReport } from './report';
import type { AdminEvalTurn } from './run';

const turn = (category: AdminEvalTurn['category'], passed: boolean, rowId = 'r'): AdminEvalTurn => ({
  rowId,
  category,
  sample: 0,
  questId: 'secret-quest-id',
  toolsCalled: [],
  grade: { passed, checks: { view: null, tool: null, rubric: passed }, reason: passed ? 'ok' : 'nope' },
});

describe('admin eval report', () => {
  const report = buildAdminEvalReport([turn('where-is', true), turn('where-is', false, 'w2'), turn('data', true)], {
    model: 'm',
    samples: 1,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });

  it('computes rates per category and overall, null for an empty category', () => {
    expect(report.byCategory['where-is']).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(report.byCategory.data).toEqual({ passed: 1, total: 1, rate: 1 });
    expect(report.byCategory['out-of-scope']).toEqual({ passed: 0, total: 0, rate: null });
    expect(report.overall.rate).toBeCloseTo(2 / 3);
  });

  it('lists failures without quest ids', () => {
    expect(report.failures).toEqual([
      { rowId: 'w2', category: 'where-is', sample: 0, reason: 'nope', toolsCalled: [] },
    ]);
    expect(JSON.stringify(report)).not.toContain('secret-quest-id');
  });

  it('prints a row per category plus overall', () => {
    const text = formatAdminEvalReport(report);
    for (const label of ['where-is', 'how-to', 'what-is', 'data', 'out-of-scope', 'overall'])
      expect(text).toContain(label);
    expect(text).toContain('50%');
    expect(text).toContain('n/a');
    expect(text).toContain('w2#0: nope');
  });
});

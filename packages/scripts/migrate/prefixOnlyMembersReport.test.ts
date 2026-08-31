import { describe, it, expect } from 'vitest';
import {
  classifyDynamicLakeMode,
  reconcilePrefixOnly,
  isFinding,
  renderCensusReport,
  type LakeReport,
} from './prefixOnlyMembersReport';

const baseLake = (overrides: Partial<LakeReport>): LakeReport => ({
  id: 'lake-1',
  name: 'Test Lake',
  datalakeTag: 'datalake:test-lake',
  fileTagPrefix: 'acme:',
  createdByUserId: 'user-1',
  mode: 'anchored',
  total: 10,
  totalExcludingPending: 9,
  metaTagged: 8,
  prefixOnlyDirect: 2,
  reconcileMismatch: false,
  narrowingUpperBound: 0,
  unanchoredCount: null,
  prefixOnlyFiles: { fileNames: [], truncated: false },
  narrowingFiles: { fileNames: [], truncated: false },
  ...overrides,
});

describe('classifyDynamicLakeMode', () => {
  it('classifies a valid prefix + creator as anchored', () => {
    expect(classifyDynamicLakeMode({ fileTagPrefix: 'acme:', createdByUserId: 'user-1' })).toBe('anchored');
  });

  it('classifies a missing prefix as no-prefix', () => {
    expect(classifyDynamicLakeMode({ fileTagPrefix: undefined, createdByUserId: 'user-1' })).toBe('no-prefix');
  });

  it('classifies a colon-less prefix as no-prefix', () => {
    expect(classifyDynamicLakeMode({ fileTagPrefix: 'acme', createdByUserId: 'user-1' })).toBe('no-prefix');
  });

  it('classifies a reserved (datalake:) prefix as no-prefix', () => {
    expect(classifyDynamicLakeMode({ fileTagPrefix: 'datalake:acme:', createdByUserId: 'user-1' })).toBe('no-prefix');
  });

  it('classifies a missing creator as creator-less', () => {
    expect(classifyDynamicLakeMode({ fileTagPrefix: 'acme:', createdByUserId: undefined })).toBe('creator-less');
  });

  it('classifies an empty-string creator as creator-less, not anchored', () => {
    // createdByUserId: '' is a real stored value in this codebase (a synthetic registry
    // fallback), and '' is falsy - the classifier must test truthiness, not `!= null`.
    expect(classifyDynamicLakeMode({ fileTagPrefix: 'acme:', createdByUserId: '' })).toBe('creator-less');
  });

  it('prefers no-prefix over creator-less when both conditions hold', () => {
    expect(classifyDynamicLakeMode({ fileTagPrefix: undefined, createdByUserId: '' })).toBe('no-prefix');
  });
});

describe('reconcilePrefixOnly', () => {
  it('matches when total - metaTagged equals the direct count', () => {
    expect(reconcilePrefixOnly(10, 8, 2)).toEqual({ expected: 2, actual: 2, matches: true });
  });

  it('flags a mismatch when the two counts disagree', () => {
    expect(reconcilePrefixOnly(10, 8, 3)).toEqual({ expected: 2, actual: 3, matches: false });
  });
});

describe('isFinding', () => {
  it('does not escalate an anchored lake with zero widening and zero narrowing', () => {
    expect(isFinding(baseLake({ prefixOnlyDirect: 0, narrowingUpperBound: 0 }))).toBe(false);
  });

  it('escalates an anchored lake with a nonzero widening count', () => {
    expect(isFinding(baseLake({ prefixOnlyDirect: 1, narrowingUpperBound: 0 }))).toBe(true);
  });

  it('escalates an anchored lake with a nonzero narrowing count even if widening is zero', () => {
    expect(isFinding(baseLake({ prefixOnlyDirect: 0, narrowingUpperBound: 1 }))).toBe(true);
  });

  it('never escalates a no-prefix lake', () => {
    expect(isFinding(baseLake({ mode: 'no-prefix', prefixOnlyDirect: null, narrowingUpperBound: null }))).toBe(false);
  });

  it('never escalates an open (registry) lake', () => {
    expect(
      isFinding(baseLake({ mode: 'open', prefixOnlyDirect: null, narrowingUpperBound: null, unanchoredCount: 50 }))
    ).toBe(false);
  });

  it('always escalates a creator-less lake, even with a zero unanchored count', () => {
    expect(
      isFinding(
        baseLake({ mode: 'creator-less', prefixOnlyDirect: null, narrowingUpperBound: null, unanchoredCount: 0 })
      )
    ).toBe(true);
  });
});

describe('renderCensusReport', () => {
  it('exits 0 with no findings when every lake is clean', () => {
    const result = renderCensusReport([baseLake({ prefixOnlyDirect: 0, narrowingUpperBound: 0 })], 'dev');
    expect(result.exitCode).toBe(0);
    expect(result.findingsCount).toBe(0);
  });

  it('exits 2 and names the lake when a finding exists', () => {
    const result = renderCensusReport([baseLake({ prefixOnlyDirect: 3 })], 'dev');
    expect(result.exitCode).toBe(2);
    expect(result.findingsCount).toBe(1);
    expect(result.lines.some(l => l.includes('Test Lake'))).toBe(true);
  });

  it('never prints a bare "0" for a creator-less lake', () => {
    const result = renderCensusReport(
      [
        baseLake({
          mode: 'creator-less',
          prefixOnlyDirect: null,
          narrowingUpperBound: null,
          unanchoredCount: 0,
          total: null,
          totalExcludingPending: null,
          metaTagged: null,
        }),
      ],
      'dev'
    );
    const memberLine = result.lines.find(l => l.includes('prefix-only members:'));
    expect(memberLine).toContain('n/a (fails closed)');
    expect(memberLine).not.toBe('  prefix-only members: 0');
  });

  it('labels the narrowing count as an upper bound and states a nonzero value is correct', () => {
    const result = renderCensusReport([baseLake({ prefixOnlyDirect: 0, narrowingUpperBound: 5 })], 'dev');
    expect(result.lines.some(l => l.includes('narrowing upper bound') && l.includes('5'))).toBe(true);
    expect(result.lines.some(l => l.toLowerCase().includes('not a defect'))).toBe(true);
  });

  it('surfaces a RECONCILE line when the two widening counts disagree', () => {
    const result = renderCensusReport(
      [baseLake({ reconcileMismatch: true, total: 10, metaTagged: 8, prefixOnlyDirect: 3 })],
      'dev'
    );
    expect(result.lines.some(l => l.startsWith('  RECONCILE:'))).toBe(true);
    expect(result.reconcileMismatchCount).toBe(1);
  });
});

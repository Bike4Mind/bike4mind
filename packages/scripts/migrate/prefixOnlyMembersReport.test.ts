import { describe, it, expect } from 'vitest';
import {
  censusResultLine,
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
  prefixOnlyFiles: { files: [], truncated: false },
  narrowingFiles: { files: [], truncated: false },
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

  it('classifies a reserved (datalake:) prefix as its OWN mode, never no-prefix', () => {
    // Folding this into no-prefix is the false zero the census exists to catch: retrieval honours
    // a reserved prefix today and the fix drops it, so the lake loses its whole prefix arm while
    // "0 (no prefix arm)" claims nothing moves.
    expect(classifyDynamicLakeMode({ fileTagPrefix: 'datalake:acme:', createdByUserId: 'user-1' })).toBe(
      'reserved-prefix'
    );
  });

  it('prefers reserved-prefix over creator-less when both conditions hold', () => {
    expect(classifyDynamicLakeMode({ fileTagPrefix: 'datalake:acme:', createdByUserId: '' })).toBe('reserved-prefix');
  });

  it('still classifies an unusable (colon-less) prefix as no-prefix, not reserved', () => {
    expect(classifyDynamicLakeMode({ fileTagPrefix: 'datalake', createdByUserId: 'user-1' })).toBe('no-prefix');
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

  it('always escalates a reserved-prefix lake, even with a zero unanchored count', () => {
    expect(
      isFinding(
        baseLake({ mode: 'reserved-prefix', prefixOnlyDirect: null, narrowingUpperBound: null, unanchoredCount: 0 })
      )
    ).toBe(true);
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

  it('exits 2 and names the lake IN THE SUMMARY when a finding exists', () => {
    const result = renderCensusReport([baseLake({ prefixOnlyDirect: 3 })], 'dev');
    expect(result.exitCode).toBe(2);
    expect(result.findingsCount).toBe(1);
    // Must assert against the summary line specifically. A bare `lines.some(includes('Test Lake'))`
    // is vacuous: renderLakeLines emits a `Lake "Test Lake" (...)` header for EVERY lake, so it
    // passes even with the whole summary block deleted.
    const summary = result.lines.find(l => l.includes('need owner sign-off before'));
    expect(summary).toBeDefined();
    expect(summary).toContain('Test Lake');
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

  it('tells the operator a RECONCILE mismatch may just be a concurrent write', () => {
    // The three counts are unsynchronized countDocuments calls, so a mismatch does NOT prove the
    // queries diverged. Without this the operator reads a hard "do not trust" and stops.
    const result = renderCensusReport([baseLake({ reconcileMismatch: true })], 'dev');
    const line = result.lines.find(l => l.startsWith('  RECONCILE:'));
    expect(line).toMatch(/[Rr]e-run/);
    expect(line).toMatch(/unsynchronized/);
  });

  // The next two cover modeColumn branches that no test reached before: both could be replaced
  // with arbitrary strings and the whole suite stayed green.
  it('renders a no-prefix lake without escalating it', () => {
    const result = renderCensusReport(
      [baseLake({ mode: 'no-prefix', fileTagPrefix: 'acme', prefixOnlyDirect: null, narrowingUpperBound: null })],
      'dev'
    );
    expect(result.lines.find(l => l.includes('prefix-only members:'))).toContain('0 (no prefix arm)');
    expect(result.exitCode).toBe(0);
    expect(result.findingsCount).toBe(0);
  });

  it('renders an open (registry) lake with its unanchored count, without escalating it', () => {
    const result = renderCensusReport(
      [
        baseLake({
          mode: 'open',
          prefixOnlyDirect: null,
          narrowingUpperBound: null,
          unanchoredCount: 50,
          total: null,
          totalExcludingPending: null,
          metaTagged: null,
        }),
      ],
      'dev'
    );
    const memberLine = result.lines.find(l => l.includes('prefix-only members:'));
    expect(memberLine).toContain('50');
    expect(memberLine).toContain('OPEN arm');
    expect(result.exitCode).toBe(0);
  });

  it('escalates a reserved-prefix lake and labels its number over-match, not narrowing', () => {
    const result = renderCensusReport(
      [
        baseLake({
          mode: 'reserved-prefix',
          fileTagPrefix: 'datalake:acme:',
          prefixOnlyDirect: null,
          narrowingUpperBound: null,
          unanchoredCount: 900,
        }),
      ],
      'dev'
    );
    expect(result.exitCode).toBe(2);
    expect(result.findingsCount).toBe(1);
    expect(result.lines.some(l => l.includes('ESCALATE') && l.includes('reserved'))).toBe(true);
    // The figure is inflated by construction (a `datalake:` regex matches other lakes' meta-tags),
    // so it must never be presented as a narrowing/member count.
    const memberLine = result.lines.find(l => l.includes('prefix-only members:'));
    expect(memberLine).toContain('over-match');
    expect(memberLine).not.toContain('narrowing');
    expect(result.lines.some(l => l.includes('NOT a member count'))).toBe(true);
  });

  it('prints fileTagPrefix so a malformed or reserved value is visible', () => {
    const result = renderCensusReport([baseLake({ fileTagPrefix: 'acme: ' })], 'dev');
    // JSON-quoted on purpose: bare printing hides the trailing space that made it unusable.
    expect(result.lines.some(l => l.includes('fileTagPrefix="acme: "'))).toBe(true);
  });

  // A RECONCILE mismatch used to leave exitCode at 0 and the summary at "No lake needs owner
  // sign-off." while main() aborted the run - so the two signals the docblock calls authoritative
  // both said CLEAN on a census that had just declared itself untrustworthy.
  it('exits 1 on a RECONCILE mismatch even when NO lake escalates', () => {
    const result = renderCensusReport(
      [baseLake({ reconcileMismatch: true, total: 1, metaTagged: 0, prefixOnlyDirect: 0, narrowingUpperBound: 0 })],
      'production'
    );
    expect(result.findingsCount).toBe(0);
    expect(result.reconcileMismatchCount).toBe(1);
    expect(result.exitCode).toBe(1);
  });

  it('never prints a clean summary on a RECONCILE mismatch', () => {
    const result = renderCensusReport(
      [baseLake({ reconcileMismatch: true, total: 1, metaTagged: 0, prefixOnlyDirect: 0, narrowingUpperBound: 0 })],
      'production'
    );
    expect(result.lines).not.toContain('No lake needs owner sign-off.');
    expect(result.lines.some(l => l.includes('DO NOT MERGE'))).toBe(true);
  });

  it('a mismatch outranks a findings verdict rather than sitting beside it', () => {
    const result = renderCensusReport([baseLake({ reconcileMismatch: true, prefixOnlyDirect: 3 })], 'production');
    expect(result.findingsCount).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(result.lines.some(l => l.includes('need owner sign-off before'))).toBe(false);
  });

  it('surfaces the missing creator even when the lake is ALSO reserved-prefix', () => {
    // classifyDynamicLakeMode short-circuits on the reserved prefix, so keying the ESCALATE line
    // off `mode === 'creator-less'` hid the data-quality defect entirely on stdout.
    const result = renderCensusReport(
      [baseLake({ mode: 'reserved-prefix', fileTagPrefix: 'datalake:acme:', createdByUserId: '', unanchoredCount: 4 })],
      'production'
    );
    expect(result.lines.some(l => l.includes('no creator on record'))).toBe(true);
  });

  it('does not claim a missing creator for a registry (open) lake', () => {
    const result = renderCensusReport(
      [baseLake({ mode: 'open', createdByUserId: null, total: null, totalExcludingPending: null, metaTagged: null })],
      'production'
    );
    expect(result.lines.some(l => l.includes('no creator on record'))).toBe(false);
  });

  it('marks the widening listing as truncated, not just the narrowing one', () => {
    const result = renderCensusReport(
      [baseLake({ prefixOnlyDirect: 501, prefixOnlyFiles: { files: [], truncated: true } })],
      'dev'
    );
    expect(result.lines.find(l => l.includes('prefix-only members:'))).toContain('(truncated listing)');
  });
});

describe('censusResultLine', () => {
  it('reports CENSUS FAILED, not a verdict, when the census could not be trusted', () => {
    const line = censusResultLine(1, 0, 2);
    expect(line).toContain('CENSUS FAILED');
    expect(line).toContain('2 lake(s) failed the RECONCILE');
    expect(line).not.toContain('CLEAN');
  });

  it('reports CLEAN only on 0 and the sign-off count on 2', () => {
    expect(censusResultLine(0, 0, 0)).toContain('CLEAN, no lake needs owner sign-off');
    expect(censusResultLine(2, 3, 0)).toContain('3 lake(s) NEED OWNER SIGN-OFF');
  });

  it('always tells the operator not to trust the shell exit code', () => {
    for (const code of [0, 1, 2] as const) {
      expect(censusResultLine(code, 1, 1)).toContain('not $?');
    }
  });
});

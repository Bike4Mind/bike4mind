import { describe, it, expect } from 'vitest';
import { ELISION_WARNING } from '@bike4mind/common';
import { buildElisionStamp, truncateElisionText, MAX_ELISION_DETAILS, type ElisionHit } from './elisionStamp';

const hit = (confidence: 'high' | 'low', ...signals: string[]): ElisionHit => ({ confidence, signals });

describe('buildElisionStamp', () => {
  it('returns null when nothing was detected, so promptMeta is left untouched', () => {
    expect(buildElisionStamp([], { wasTruncated: false, priorWarnings: [] })).toBeNull();
  });

  it('reports high confidence when ANY artifact was high', () => {
    const stamp = buildElisionStamp([hit('low', 'a'), hit('high', 'b'), hit('low', 'c')], {
      wasTruncated: false,
      priorWarnings: [],
    });

    expect(stamp?.suspectedElision.confidence).toBe('high');
  });

  it('reports low confidence only when every artifact was low', () => {
    const stamp = buildElisionStamp([hit('low', 'a'), hit('low', 'b')], {
      wasTruncated: false,
      priorWarnings: [],
    });

    expect(stamp?.suspectedElision.confidence).toBe('low');
  });

  it('counts every signal across artifacts, not just the persisted ones', () => {
    const many = Array.from({ length: MAX_ELISION_DETAILS + 5 }, (_, i) => `signal-${i}`);
    const stamp = buildElisionStamp([hit('high', ...many)], { wasTruncated: false, priorWarnings: [] });

    expect(stamp?.suspectedElision.signalCount).toBe(MAX_ELISION_DETAILS + 5);
  });

  it('marks the details list when it is capped, so it cannot read as complete', () => {
    const many = Array.from({ length: MAX_ELISION_DETAILS + 5 }, (_, i) => `signal-${i}`);
    const details = buildElisionStamp([hit('high', ...many)], {
      wasTruncated: false,
      priorWarnings: [],
    })!.suspectedElision.details;

    expect(details).toHaveLength(MAX_ELISION_DETAILS + 1);
    expect(details[MAX_ELISION_DETAILS]).toBe('(+5 more not shown)');
  });

  it('adds no marker when the details fit exactly at the cap', () => {
    const exact = Array.from({ length: MAX_ELISION_DETAILS }, (_, i) => `signal-${i}`);
    const details = buildElisionStamp([hit('high', ...exact)], {
      wasTruncated: false,
      priorWarnings: [],
    })!.suspectedElision.details;

    expect(details).toHaveLength(MAX_ELISION_DETAILS);
    expect(details.some(d => d.includes('not shown'))).toBe(false);
  });

  it('appends the user-facing warning once, preserving earlier warnings', () => {
    const stamp = buildElisionStamp([hit('high', 'a')], {
      wasTruncated: false,
      priorWarnings: ['something else happened'],
    });

    expect(stamp?.warnings).toEqual(['something else happened', ELISION_WARNING]);
  });

  it('does not append the warning twice if the block runs again for one completion', () => {
    const stamp = buildElisionStamp([hit('high', 'a')], {
      wasTruncated: false,
      priorWarnings: ['something else happened', ELISION_WARNING],
    });

    expect(stamp?.warnings.filter(w => w === ELISION_WARNING)).toHaveLength(1);
  });

  it('suppresses the warning when the response also hit the output ceiling', () => {
    // Truncation has its own, more accurate warning and the client suppresses the elision banner in
    // that case, so stamping both reported one underlying event twice.
    const stamp = buildElisionStamp([hit('high', 'a')], { wasTruncated: true, priorWarnings: [] });

    expect(stamp?.warnings).toEqual([]);
  });

  it('still records the verdict when truncated, because it is the diagnostic record', () => {
    const stamp = buildElisionStamp([hit('high', 'a')], { wasTruncated: true, priorWarnings: [] });

    expect(stamp?.suspectedElision).toMatchObject({ confidence: 'high', signalCount: 1 });
  });

  it('does not mutate the caller-supplied warnings array', () => {
    const prior = ['first'];
    buildElisionStamp([hit('high', 'a')], { wasTruncated: false, priorWarnings: prior });

    expect(prior).toEqual(['first']);
  });
});

describe('truncateElisionText', () => {
  it('leaves text at or under the cap alone', () => {
    expect(truncateElisionText('abcde', 5)).toBe('abcde');
  });

  it('marks text it clips, so a partial value never reads as whole', () => {
    expect(truncateElisionText('abcdefgh', 5)).toBe('abcde...[truncated]');
  });
});

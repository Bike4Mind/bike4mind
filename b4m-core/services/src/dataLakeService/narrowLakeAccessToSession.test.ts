import { describe, it, expect } from 'vitest';
import { narrowLakeAccessToSession, type ResolvedLakeAccessSet } from './narrowLakeAccessToSession';

const lake = (id: string, source: 'registry' | 'dynamic') => ({
  id,
  name: id,
  slug: id,
  datalakeTag: `datalake:${id}`,
  fileTagPrefix: `${id}:`,
  source,
});

const access = (): ResolvedLakeAccessSet => ({
  dataLakeTags: ['datalake:alpha', 'datalake:beta'],
  dataLakeTagPrefixes: ['alpha:'], // OPEN bucket - registry-sourced only
  scopedTagPrefixes: ['beta:'], // owner/org-scoped bucket
  lakes: [lake('alpha', 'registry'), lake('beta', 'dynamic')] as ResolvedLakeAccessSet['lakes'],
});

describe('narrowLakeAccessToSession', () => {
  it('keeps only the session lake, dropping the other lake from every bucket', () => {
    const out = narrowLakeAccessToSession(access(), ['datalake:beta']);
    expect(out.dataLakeTags).toEqual(['datalake:beta']);
    expect(out.scopedTagPrefixes).toEqual(['beta:']);
    // The dropped lake's prefix must not survive in the OPEN bucket either.
    expect(out.dataLakeTagPrefixes).toEqual([]);
    expect(out.lakes.map(l => l.datalakeTag)).toEqual(['datalake:beta']);
  });

  it('never promotes a dynamic lake prefix into the OPEN ownership-bypass bucket', () => {
    const out = narrowLakeAccessToSession(access(), ['datalake:beta']);
    // beta is dynamic; its prefix belongs in scopedTagPrefixes and must stay there.
    expect(out.dataLakeTagPrefixes).not.toContain('beta:');
    expect(out.scopedTagPrefixes).toContain('beta:');
  });

  it('is purely subtractive - it can never add a tag or prefix the caller lacked', () => {
    const out = narrowLakeAccessToSession(access(), ['datalake:alpha', 'datalake:not-mine']);
    expect(out.dataLakeTags).toEqual(['datalake:alpha']);
    expect(out.dataLakeTags).not.toContain('datalake:not-mine');
  });

  it('yields empty access when the session names only unreachable lakes', () => {
    const out = narrowLakeAccessToSession(access(), ['datalake:not-mine']);
    expect(out.dataLakeTags).toEqual([]);
    expect(out.dataLakeTagPrefixes).toEqual([]);
    expect(out.scopedTagPrefixes).toEqual([]);
    expect(out.lakes).toEqual([]);
  });

  it('is a no-op for an unscoped session', () => {
    const original = access();
    expect(narrowLakeAccessToSession(original, undefined)).toBe(original);
    expect(narrowLakeAccessToSession(original, [])).toBe(original);
  });
});

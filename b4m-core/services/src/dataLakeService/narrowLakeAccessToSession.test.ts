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

  it('keeps a retained dynamic lake prefix in its own bucket, never the OPEN one', () => {
    const out = narrowLakeAccessToSession(access(), ['datalake:beta']);
    // Only the second assertion carries weight: 'beta:' is never in the OPEN bucket to begin with,
    // so asserting its absence there passes however the function behaves. Kept as a bucket-identity
    // check, with the real OPEN-bucket filtering covered by the first test.
    expect(out.scopedTagPrefixes).toContain('beta:');
    expect(out.dataLakeTagPrefixes).toEqual([]);
  });

  it('a dynamic lake sharing a retained registry lake prefix does not narrow it away (fail-safe)', () => {
    // Prefixes match BY VALUE (see narrowLakeAccessToSession), so a colliding prefix survives on
    // the retained lake's behalf. Subtractive still holds - nothing new is granted - but the
    // narrowing is weaker than the lake list suggests. Pinning today's behavior deliberately.
    const colliding: ResolvedLakeAccessSet = {
      dataLakeTags: ['datalake:alpha', 'datalake:beta'],
      dataLakeTagPrefixes: ['alpha:'],
      scopedTagPrefixes: [],
      lakes: [lake('alpha', 'registry'), { ...lake('beta', 'dynamic'), fileTagPrefix: 'alpha:' }],
    } as ResolvedLakeAccessSet;
    const out = narrowLakeAccessToSession(colliding, ['datalake:beta']);
    expect(out.lakes.map(l => l.datalakeTag)).toEqual(['datalake:beta']);
    // alpha: survives because retained beta claims the same prefix value.
    expect(out.dataLakeTagPrefixes).toEqual(['alpha:']);
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

describe('narrowLakeAccessToSession with non-lake retrievalTags', () => {
  it('is a no-op when the session is scoped by a CONTENT tag, not a lake tag', () => {
    // A curated surface scopes by course/content tag; those are a file-tag filter elsewhere. Matching
    // them against lake identity would retain zero lakes and silently empty the tool's lake arms.
    const original = access();
    expect(narrowLakeAccessToSession(original, ['some-course-2026'])).toBe(original);
    expect(narrowLakeAccessToSession(original, ['acme:'])).toBe(original);
  });

  it('still narrows on the lake subset when both kinds are present', () => {
    const out = narrowLakeAccessToSession(access(), ['some-course-2026', 'datalake:beta']);
    expect(out.dataLakeTags).toEqual(['datalake:beta']);
  });
});

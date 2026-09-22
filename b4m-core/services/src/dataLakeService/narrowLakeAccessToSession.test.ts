import { describe, it, expect } from 'vitest';
import {
  narrowLakeAccessToSession,
  sessionGroundsOnNoLake,
  type ResolvedLakeAccessSet,
} from './narrowLakeAccessToSession';

const lake = (id: string, source: 'registry' | 'dynamic') => ({
  id,
  name: id,
  slug: id,
  datalakeTag: `datalake:${id}`,
  fileTagPrefix: `${id}:`,
  membership:
    source === 'dynamic'
      ? { kind: 'owned' as const, datalakeTag: `datalake:${id}`, fileTagPrefix: `${id}:`, creatorUserId: `${id}-owner` }
      : { kind: 'registry' as const, datalakeTag: `datalake:${id}`, fileTagPrefix: `${id}:` },
  source,
});

const access = (): ResolvedLakeAccessSet => ({
  dataLakeTags: ['datalake:alpha', 'datalake:beta'],
  dataLakeTagPrefixes: ['alpha:'], // OPEN bucket - registry-sourced only
  scopedTagPrefixes: ['beta:'], // owner/org-scoped bucket
  lakes: [lake('alpha', 'registry'), lake('beta', 'dynamic')] as ResolvedLakeAccessSet['lakes'],
  excludedByAccessCount: 0,
});

describe('narrowLakeAccessToSession', () => {
  /**
   * This function REBUILDS the access object, so the completeness flag has to be carried across
   * deliberately. Dropping it would report a degraded view to every consumer downstream of a
   * session-scoped narrowing and silently disable any narrowing that keys on it.
   */
  it('carries lakeViewComplete through a narrowing, in both states', () => {
    const degraded = { ...access(), lakeViewComplete: false };
    expect(narrowLakeAccessToSession(degraded, ['datalake:beta']).lakeViewComplete).toBe(false);

    const complete = { ...access(), lakeViewComplete: true };
    expect(narrowLakeAccessToSession(complete, ['datalake:beta']).lakeViewComplete).toBe(true);
  });

  /**
   * #3055 (review onoya): a NARROWED session cannot honestly claim the account-wide count as its
   * own - the caller can access lake `alpha`, could be excluded from some unrelated lake `zulu`
   * elsewhere in the org, and a session scoped to `alpha` alone must not report `zulu`'s exclusion
   * as if it were in this turn's scope. Dropping to undefined (not measured) is the honest answer;
   * reporting the account-wide number would be a false claim about THIS turn.
   */
  it('drops excludedByAccessCount to undefined on an actual narrowing, never the account-wide number', () => {
    const withExclusions = { ...access(), excludedByAccessCount: 3 };
    expect(narrowLakeAccessToSession(withExclusions, ['datalake:beta']).excludedByAccessCount).toBeUndefined();
  });

  /**
   * The no-op path (session names no lake at all) returns the input object outright - nothing was
   * narrowed away, so the account-wide count still describes exactly this turn's scope.
   */
  it('carries excludedByAccessCount through the no-op path unchanged', () => {
    const withExclusions = { ...access(), excludedByAccessCount: 3 };
    expect(narrowLakeAccessToSession(withExclusions, undefined).excludedByAccessCount).toBe(3);
  });

  it('keeps only the session lake, dropping the other lake from every bucket', () => {
    const out = narrowLakeAccessToSession(access(), ['datalake:beta']);
    expect(out.dataLakeTags).toEqual(['datalake:beta']);
    expect(out.scopedTagPrefixes).toEqual(['beta:']);
    // The dropped lake's prefix must not survive in the OPEN bucket either.
    expect(out.dataLakeTagPrefixes).toEqual([]);
    expect(out.lakes.map(l => l.datalakeTag)).toEqual(['datalake:beta']);
  });

  // #2243: retrieval derives its membership arms from `lakes` (see lakeMembershipsFrom), so
  // narrowing must carry a retained lake's membership scope through UNCHANGED - this function
  // filters `lakes` in place and never rebuilds it, which is what makes that true.
  it('narrowing to one lake leaves exactly that lake, with its membership scope intact', () => {
    const membership = { datalakeTag: 'datalake:beta', fileTagPrefix: 'beta:', creatorUserId: 'creator-1' };
    const withMembership: ResolvedLakeAccessSet = {
      ...access(),
      lakes: [lake('alpha', 'registry'), { ...lake('beta', 'dynamic'), membership }] as ResolvedLakeAccessSet['lakes'],
    };

    const out = narrowLakeAccessToSession(withMembership, ['datalake:beta']);

    expect(out.lakes).toHaveLength(1);
    expect((out.lakes[0] as { membership?: unknown }).membership).toEqual(membership);
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
    // Built from access() rather than a bare object literal + cast, so a future required field on
    // ResolvedLakeAccessSet cannot slip through here uncaught the way excludedByAccessCount once
    // did (#3055) - a cast literal satisfies the type whether or not the field is present.
    const colliding: ResolvedLakeAccessSet = {
      ...access(),
      dataLakeTags: ['datalake:alpha', 'datalake:beta'],
      dataLakeTagPrefixes: ['alpha:'],
      scopedTagPrefixes: [],
      lakes: [
        lake('alpha', 'registry'),
        { ...lake('beta', 'dynamic'), fileTagPrefix: 'alpha:' },
      ] as ResolvedLakeAccessSet['lakes'],
    };
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

describe('narrowLakeAccessToSession prefix identity', () => {
  it('narrows on a lake named by its FILE-TAG PREFIX, not just by identity', () => {
    // The branch the docstring says exists to stop a prefix-scoped session falling back to the full
    // owner-wide union. Every other test names lakes by identity, so this path shipped untested.
    const out = narrowLakeAccessToSession(access(), ['beta:']);
    expect(out.lakes.map(l => l.datalakeTag)).toEqual(['datalake:beta']);
    expect(out.scopedTagPrefixes).toEqual(['beta:']);
  });

  it('unions identity and prefix matches rather than letting identity win alone', () => {
    const out = narrowLakeAccessToSession(access(), ['datalake:alpha', 'beta:']);
    expect(out.lakes.map(l => l.datalakeTag).sort()).toEqual(['datalake:alpha', 'datalake:beta']);
  });
});

/**
 * The third state. Every row that is NOT the deliberate empty scope must answer false, because a
 * false here sends the caller down the narrowing - which no-ops on an empty list and hands back
 * the caller's whole owner-wide lake access. Getting any of these backwards either grounds a chat
 * on every entitled lake while the UI says it grounds on none, or silently blinds a session that
 * only ever had a tag derived for it.
 */
describe('sessionGroundsOnNoLake', () => {
  it.each([
    ['empty tags, marked explicit - the deliberate no-lake scope', [] as string[] | undefined, true, true],
    ['absent tags, marked explicit - same state; Mongoose hydrates an unset array to []', undefined, true, true],
    ['empty tags, unmarked - no opinion, falls back to every reachable lake', [], undefined, false],
    ['empty tags, explicitly unmarked', [], false, false],
    ['absent tags, unmarked', undefined, undefined, false],
    ['tags present and marked - a real scope, the narrowing handles it', ['datalake:alpha'], true, false],
    ['tags present, unmarked - a derived scope, still a real one', ['datalake:alpha'], undefined, false],
    ['a non-lake tag with the marker - still names something, not nothing', ['course-2026'], true, false],
  ])('%s', (_label, tags, explicit, expected) => {
    expect(sessionGroundsOnNoLake(tags as string[] | undefined, explicit as boolean | undefined)).toBe(expected);
  });
});

import { describe, it, expect } from 'vitest';
import { attributeAccessedLakeIds, attributeFileToLakeIds } from './attributeAccessedLakes';

const LAKES = [
  { id: 'lake1', datalakeTag: 'datalake:lake1' },
  { id: 'lake2', datalakeTag: 'datalake:lake2' },
];

describe('attributeAccessedLakeIds', () => {
  it('maps a datalake tag on a file back to its lake id', () => {
    expect(attributeAccessedLakeIds([['datalake:lake1', 'other:tag']], LAKES)).toEqual(['lake1']);
  });

  it('dedupes across multiple files matching the same lake', () => {
    expect(attributeAccessedLakeIds([['datalake:lake1'], ['datalake:lake1']], LAKES)).toEqual(['lake1']);
  });

  it('attributes multiple distinct lakes across a result set', () => {
    const ids = attributeAccessedLakeIds([['datalake:lake1'], ['datalake:lake2']], LAKES);
    expect(new Set(ids)).toEqual(new Set(['lake1', 'lake2']));
  });

  it('falls back to the full scope when a datalake tag does not match any known lake', () => {
    expect(new Set(attributeAccessedLakeIds([['datalake:unknown-lake']], LAKES))).toEqual(new Set(['lake1', 'lake2']));
  });

  it('falls back to the full scope when no file carries a datalake tag (e.g. a pure prefix match)', () => {
    expect(new Set(attributeAccessedLakeIds([['some:content:tag']], LAKES))).toEqual(new Set(['lake1', 'lake2']));
  });

  it('falls back to the full scope for an empty result set', () => {
    expect(new Set(attributeAccessedLakeIds([], LAKES))).toEqual(new Set(['lake1', 'lake2']));
  });

  it('returns empty when the scope itself is empty, even with no attribution', () => {
    expect(attributeAccessedLakeIds([['some:content:tag']], [])).toEqual([]);
  });

  describe('allowFullScopeFallback: false (mixed-corpus callers)', () => {
    it('still attributes normally when a tag actually matches', () => {
      const ids = attributeAccessedLakeIds([['datalake:lake1']], LAKES, { allowFullScopeFallback: false });
      expect(ids).toEqual(['lake1']);
    });

    it('returns empty, not the full scope, when nothing carries a recoverable tag', () => {
      expect(attributeAccessedLakeIds([['some:content:tag']], LAKES, { allowFullScopeFallback: false })).toEqual([]);
    });

    it('returns empty, not the full scope, for an empty result set', () => {
      expect(attributeAccessedLakeIds([], LAKES, { allowFullScopeFallback: false })).toEqual([]);
    });

    it('returns empty when a tag matches no known lake', () => {
      expect(attributeAccessedLakeIds([['datalake:unknown-lake']], LAKES, { allowFullScopeFallback: false })).toEqual(
        []
      );
    });
  });

  // `opti-knowledge` is a REAL id in @bike4mind/common's static registry (STATIC_LAKE_IDS) -
  // a file granted through its open prefix structurally cannot carry `datalake:opti-knowledge`
  // (no write path stamps a meta-tag on a fallback lake), so this is the NORMAL shape of a read
  // there, not an edge case. A fixture id like 'lake1' above is never in the real registry, so
  // it could never exercise this arm - these use the real id on purpose.
  describe('open (static-registry) prefix attribution', () => {
    const STATIC_LAKE = { id: 'opti-knowledge', datalakeTag: 'datalake:opti-knowledge', fileTagPrefix: 'opti:' };
    const DYNAMIC_LAKE = { id: 'dyn-1', datalakeTag: 'datalake:org1:handbook', fileTagPrefix: 'handbook:' };

    it('attributes a prefix-only match to the static lake even with allowFullScopeFallback: false', () => {
      const ids = attributeAccessedLakeIds([['opti:policy']], [STATIC_LAKE], { allowFullScopeFallback: false });
      expect(ids).toEqual(['opti-knowledge']);
    });

    it('prefers the exact meta-tag over the prefix arm when a file somehow carries both', () => {
      const ids = attributeAccessedLakeIds([['datalake:opti-knowledge', 'opti:policy']], [STATIC_LAKE], {
        allowFullScopeFallback: false,
      });
      expect(ids).toEqual(['opti-knowledge']);
    });

    it('does not attribute via a dynamic lake prefix - user-controlled, never a standalone signal', () => {
      const ids = attributeAccessedLakeIds([['handbook:onboarding']], [DYNAMIC_LAKE], {
        allowFullScopeFallback: false,
      });
      expect(ids).toEqual([]);
    });

    it('mixed result set: attributes only the file that actually carries the open prefix', () => {
      const ids = attributeAccessedLakeIds([['opti:policy'], ['personal:draft']], [STATIC_LAKE], {
        allowFullScopeFallback: false,
      });
      expect(ids).toEqual(['opti-knowledge']);
    });
  });

  describe('nameless tag entries', () => {
    const STATIC = { id: 'opti-knowledge', datalakeTag: 'datalake:opti', fileTagPrefix: 'opti:' };

    // FabFile.tags is a schema-less [Object] array, so `tags.map(t => t.name)` on a legacy row can
    // hand this a list with holes in it. Callers string-inspect nothing themselves, so a throw here
    // would take down a whole search.
    it('ignores non-string tag names rather than throwing', () => {
      const tags = [undefined, null, 'datalake:lake1', 42] as unknown as string[];
      expect(attributeFileToLakeIds(tags, LAKES)).toEqual(['lake1']);
    });

    it('ignores non-string tag names on the open-prefix arm too', () => {
      const tags = [undefined, 'opti:policy'] as unknown as string[];
      expect(attributeFileToLakeIds(tags, [STATIC])).toEqual(['opti-knowledge']);
    });

    it('a file whose tags are all unnameable attributes to nothing', () => {
      const tags = [undefined, null] as unknown as string[];
      expect(attributeFileToLakeIds(tags, LAKES)).toEqual([]);
    });
  });
});

/**
 * The creator-anchored prefix arm: a DYNAMIC lake's `fileTagPrefix` is user-chosen, so it names a
 * lake only in conjunction with the lake creator owning the file. This is the in-memory mirror of
 * `buildDataLakeMembershipFilter`'s `owned` branch; the real-server parity guard for it lives in
 * apps/client/server/services/dataLakeMembershipAttributionParity.e2e.test.ts.
 */
describe('attributeFileToLakeIds: dynamic-lake membership arm', () => {
  const CREATOR = 'creator-1';
  const DYNAMIC = {
    id: 'lakeDyn',
    datalakeTag: 'datalake:acme',
    fileTagPrefix: 'acme:',
    membership: {
      kind: 'owned' as const,
      datalakeTag: 'datalake:acme',
      fileTagPrefix: 'acme:',
      creatorUserId: CREATOR,
    },
  };

  it("attributes a prefix-only member the lake's creator owns", () => {
    expect(attributeFileToLakeIds(['acme:legal'], [DYNAMIC], CREATOR)).toEqual(['lakeDyn']);
  });

  // The whole reason the prefix alone was refused before. `fileTagPrefix` is unique only per
  // creator, so without this conjunct anyone could mint a lake with prefix `acme:` and have every
  // `acme:*` file in the database attribute to it.
  it('refuses the same tag on a file owned by anyone else', () => {
    expect(attributeFileToLakeIds(['acme:legal'], [DYNAMIC], 'someone-else')).toEqual([]);
  });

  it('leaves the meta-tag arm working for a file the creator does not own', () => {
    expect(attributeFileToLakeIds(['datalake:acme'], [DYNAMIC], 'someone-else')).toEqual(['lakeDyn']);
  });

  // The audit-trail caller reverses bare tag lists and has no owner to pass. Widening the function
  // must not have changed what it already returned.
  it('is inert when no owner is supplied', () => {
    expect(attributeFileToLakeIds(['acme:legal'], [DYNAMIC])).toEqual([]);
  });

  it('fails closed to meta-tag-only for a creator-less lake row', () => {
    const creatorless = { ...DYNAMIC, membership: { ...DYNAMIC.membership, creatorUserId: null } };
    expect(attributeFileToLakeIds(['acme:legal'], [creatorless], CREATOR)).toEqual([]);
    expect(attributeFileToLakeIds(['datalake:acme'], [creatorless], CREATOR)).toEqual(['lakeDyn']);
  });

  // A registry scope's prefix arm carries NO ownership conjunct, so routing one through this arm
  // would reopen the cross-tenant hole. Registry lakes are the openLakeTagPrefix arm instead.
  it('never applies the ownership arm to a registry-kind scope', () => {
    const registryScoped = {
      id: 'not-a-static-lake',
      datalakeTag: 'datalake:acme',
      fileTagPrefix: 'acme:',
      membership: { kind: 'registry' as const, datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:' },
    };
    expect(attributeFileToLakeIds(['acme:legal'], [registryScoped], CREATOR)).toEqual([]);
  });

  it('refuses a reserved-namespace prefix, which would match every other lake meta-tag', () => {
    const reserved = {
      ...DYNAMIC,
      membership: { ...DYNAMIC.membership, fileTagPrefix: 'datalake:' },
    };
    expect(attributeFileToLakeIds(['datalake:someone-elses-lake'], [reserved], CREATOR)).toEqual([]);
  });

  // prefixArmTagNames, not satisfiesTagPrefix: the read arm's regex has no suffix requirement, so
  // a bare `acme:` genuinely IS membership and must attribute the same way the browse lists it.
  it('treats a bare prefix tag as membership, matching the read arm', () => {
    expect(attributeFileToLakeIds(['acme:'], [DYNAMIC], CREATOR)).toEqual(['lakeDyn']);
  });

  it('does not attribute a tag that merely contains the prefix', () => {
    expect(attributeFileToLakeIds(['not-acme:legal'], [DYNAMIC], CREATOR)).toEqual([]);
  });

  // Attribution is case-SENSITIVE because the read arm's regex is unflagged - a file the query
  // does not see under the prefix must not be attributed to that lake either.
  it('is case-sensitive, matching the unflagged read-arm regex', () => {
    expect(attributeFileToLakeIds(['Acme:legal'], [DYNAMIC], CREATOR)).toEqual([]);
  });

  it("a file matching two of the creator's lakes attributes to both, so the caller can refuse it", () => {
    const second = {
      id: 'lakeDyn2',
      datalakeTag: 'datalake:acme2',
      fileTagPrefix: 'acme:sub:',
      membership: {
        kind: 'owned' as const,
        datalakeTag: 'datalake:acme2',
        fileTagPrefix: 'acme:sub:',
        creatorUserId: CREATOR,
      },
    };
    const ids = attributeFileToLakeIds(['acme:sub:legal'], [DYNAMIC, second], CREATOR);
    expect(new Set(ids)).toEqual(new Set(['lakeDyn', 'lakeDyn2']));
  });
});

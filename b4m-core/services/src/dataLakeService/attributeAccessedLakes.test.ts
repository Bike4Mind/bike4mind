import { describe, it, expect } from 'vitest';
import { attributeAccessedLakeIds } from './attributeAccessedLakes';

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
});

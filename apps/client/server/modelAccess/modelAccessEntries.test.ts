import { describe, expect, it } from 'vitest';
import {
  applyAccessChange,
  applyBulkChange,
  audienceEffect,
  defaultAccessFields,
  indexEntries,
  isAdminOnly,
  nextStamp,
  sameAccess,
  toEntryDocument,
  type AccessFields,
} from './modelAccessEntries';

const fields = (extra: Partial<AccessFields> = {}): AccessFields => ({ ...defaultAccessFields(), ...extra });

describe('applyBulkChange', () => {
  it('adds only the tags an entry lacks, matching case-insensitively', () => {
    expect(
      applyBulkChange(fields({ allowedUserTags: ['Beta'] }), { addTags: ['beta', 'gamma'] }).allowedUserTags
    ).toEqual(['Beta', 'gamma']);
  });

  it('removes base with alsoRemoveBase and restores it with alsoRestoreBase', () => {
    const narrowed = applyBulkChange(fields({ allowedEntitlements: ['base', 'acme:pro'] }), {
      addTags: ['beta'],
      alsoRemoveBase: true,
    });
    expect(narrowed.allowedEntitlements).toEqual(['acme:pro']);
    const restored = applyBulkChange(narrowed, { removeTags: ['BETA'], alsoRestoreBase: true });
    expect(restored).toEqual(fields({ allowedEntitlements: ['acme:pro', 'base'] }));
  });

  it('adds and removes entitlements by normalized key', () => {
    const added = applyBulkChange(fields(), { addEntitlements: [' Base ', 'acme:pro'] });
    expect(added.allowedEntitlements).toEqual(['base', 'acme:pro']);
    expect(applyBulkChange(added, { removeEntitlements: ['ACME:PRO'] }).allowedEntitlements).toEqual(['base']);
  });
});

describe('applyAccessChange', () => {
  it('replaces lists without repeats and clears fallback and rank on empty values', () => {
    const next = applyAccessChange(fields({ fallbackModel: 'model-b', rank: 4 }), {
      allowedUserTags: ['beta', 'Beta'],
      fallbackModel: '',
      rank: null,
    });
    expect(next).toEqual(fields({ allowedUserTags: ['beta'] }));
  });
});

describe('sameAccess', () => {
  it('compares tags and entitlements as sets', () => {
    expect(sameAccess(fields({ allowedUserTags: ['a', 'B'] }), fields({ allowedUserTags: ['b', 'a'] }))).toBe(true);
    expect(sameAccess(fields(), fields({ enabled: false }))).toBe(false);
  });
});

describe('audienceEffect', () => {
  it('reads a tag added beside base as no audience change', () => {
    expect(audienceEffect(fields(), fields({ allowedUserTags: ['beta'] }))).toBe('none');
  });

  it('reads removing base, turning off and swapping tags', () => {
    const tagged = fields({ allowedUserTags: ['beta'], allowedEntitlements: [] });
    expect(audienceEffect(fields(), tagged)).toBe('narrower');
    expect(audienceEffect(tagged, fields())).toBe('wider');
    expect(audienceEffect(fields(), fields({ enabled: false }))).toBe('narrower');
    expect(audienceEffect(tagged, fields({ allowedUserTags: ['gamma'], allowedEntitlements: [] }))).toBe('mixed');
  });

  it('flags an enabled entry with no tags and no entitlements as admin-only', () => {
    expect(isAdminOnly(fields({ allowedEntitlements: [] }))).toBe(true);
    expect(isAdminOnly(fields({ enabled: false, allowedEntitlements: [] }))).toBe(false);
  });
});

describe('stored entries', () => {
  it('keeps the first entry per id and drops malformed ones', () => {
    const byId = indexEntries([{ id: 'a', enabled: true }, { id: 'a', enabled: false }, null, { enabled: true }]);
    expect([...byId.values()]).toEqual([{ id: 'a', enabled: true, allowedUserTags: [], allowedEntitlements: [] }]);
  });

  it('leaves empty entitlements out of the stored document', () => {
    const updatedAt = new Date();
    expect(toEntryDocument({ id: 'a', ...fields({ allowedEntitlements: [] }), updatedAt })).toEqual({
      id: 'a',
      enabled: true,
      allowedUserTags: [],
      updatedAt,
    });
  });

  it('moves a stamp strictly forward', () => {
    const now = new Date('2026-11-10T00:00:00.000Z');
    expect(nextStamp(now, now).getTime()).toBe(now.getTime() + 1);
    expect(nextStamp(new Date(0), now)).toBe(now);
  });
});

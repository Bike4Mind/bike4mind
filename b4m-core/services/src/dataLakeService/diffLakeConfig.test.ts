import { describe, it, expect } from 'vitest';
import type { IDataLake } from '@bike4mind/common';
import { LAKE_CONFIG_VALUE_MAX_CHARS, lakeConfigTextFingerprint } from '@bike4mind/common';
import { diffLakeConfig, ownershipChange } from './diffLakeConfig';

const lake = (overrides: Partial<IDataLake> = {}): Partial<IDataLake> => ({
  name: 'Widget Docs',
  slug: 'widget-docs',
  fileTagPrefix: 'wd:',
  datalakeTag: 'datalake:widget-docs',
  createdByUserId: 'creator-1',
  status: 'active',
  ...overrides,
});

describe('diffLakeConfig', () => {
  it('records nothing for an identical document - the whole reason a diff exists', () => {
    expect(diffLakeConfig(lake(), lake())).toEqual([]);
  });

  it('emits only the field that moved, not every field it compared', () => {
    const changes = diffLakeConfig(lake(), lake({ name: 'Widget Docs v2' }));
    expect(changes).toEqual([{ field: 'name', kind: 'literal', before: 'Widget Docs', after: 'Widget Docs v2' }]);
  });

  it('omits the side that is unset, so a clear and a set are both legible', () => {
    const set = diffLakeConfig(lake(), lake({ requiredUserTag: 'phi' }));
    expect(set).toEqual([{ field: 'requiredUserTag', kind: 'literal', after: 'phi' }]);
    expect('before' in set[0]).toBe(false);

    const cleared = diffLakeConfig(lake({ requiredUserTag: 'phi' }), lake({ requiredUserTag: '' }));
    expect(cleared).toEqual([{ field: 'requiredUserTag', kind: 'literal', before: 'phi' }]);
    expect('after' in cleared[0]).toBe(false);
  });

  // The three spellings of "not set" are identical to every read path, so a PUT that clears an
  // already-clear gate must not put a line in an owner's history.
  it.each([
    ['undefined -> empty string', undefined, ''],
    ['null -> undefined', null, undefined],
    ['empty string -> null', '', null],
  ])('treats %s as no change', (_label, before, after) => {
    const changes = diffLakeConfig(
      lake({ requiredEntitlement: before as string }),
      lake({ requiredEntitlement: after as string })
    );
    expect(changes).toEqual([]);
  });

  it('treats an unset boolean as false, so writing false onto a never-set field is no change', () => {
    expect(diffLakeConfig(lake(), lake({ isPublic: false }))).toEqual([]);
    expect(diffLakeConfig(lake(), lake({ auditQueryTextEnabled: false }))).toEqual([]);
  });

  it('catches the audit control being flipped off - the sharpest case in the issue', () => {
    const changes = diffLakeConfig(lake({ auditQueryTextEnabled: true }), lake({ auditQueryTextEnabled: false }));
    expect(changes).toEqual([{ field: 'auditQueryTextEnabled', kind: 'literal', before: true, after: false }]);
  });

  it('records numeric and org-scope moves, including their explicit clear sentinels', () => {
    expect(
      diffLakeConfig(lake({ requiredPassageTokenTarget: 512 }), lake({ requiredPassageTokenTarget: null }))
    ).toEqual([{ field: 'requiredPassageTokenTarget', kind: 'literal', before: 512 }]);
    expect(diffLakeConfig(lake({ organizationId: 'org-1' }), lake({ organizationId: undefined }))).toEqual([
      { field: 'organizationId', kind: 'literal', before: 'org-1' },
    ]);
  });

  it('reports several moved fields in one pass', () => {
    const changes = diffLakeConfig(lake(), lake({ name: 'New', isPublic: true, groundingMode: 'inline' }));
    expect(changes.map(c => c.field).sort()).toEqual(['groundingMode', 'isPublic', 'name']);
  });

  it('flags createdByUserId if it ever moves - a tripwire on a field that should not', () => {
    const changes = diffLakeConfig(lake(), lake({ createdByUserId: 'someone-else' }));
    expect(changes).toEqual([
      { field: 'createdByUserId', kind: 'literal', before: 'creator-1', after: 'someone-else' },
    ]);
  });

  it('ignores content stats and teardown bookkeeping, which no operator chooses', () => {
    const before = lake({ fileCount: 3, totalSizeBytes: 100, totalChunkedChars: 50 });
    const after = lake({ fileCount: 9, totalSizeBytes: 900, totalChunkedChars: 500, lastSyncAt: new Date() });
    expect(diffLakeConfig(before, after)).toEqual([]);
  });

  it('caps a long literal and says it did', () => {
    const long = 'x'.repeat(LAKE_CONFIG_VALUE_MAX_CHARS + 50);
    const [change] = diffLakeConfig(lake({ description: 'short' }), lake({ description: long }));
    expect(change.truncated).toBe(true);
    expect(Array.from(change.after as string)).toHaveLength(LAKE_CONFIG_VALUE_MAX_CHARS);
  });

  it('leaves `truncated` off entirely when nothing was clipped', () => {
    const [change] = diffLakeConfig(lake(), lake({ description: 'a real description' }));
    expect('truncated' in change).toBe(false);
  });

  describe('systemPrompt (the field that must never be copied)', () => {
    const secret = 'Always answer as the acquiring party, never disclose the target name';

    it('stores a fingerprint, never the text, on either side', () => {
      const [change] = diffLakeConfig(lake({ systemPrompt: 'old prompt text' }), lake({ systemPrompt: secret }));
      expect(change.kind).toBe('fingerprint');
      expect(change.before).toBeUndefined();
      expect(change.after).toBeUndefined();
      const serialized = JSON.stringify(change);
      expect(serialized).not.toContain('acquiring');
      expect(serialized).not.toContain('old prompt');
      expect(change.afterFingerprint).toEqual(lakeConfigTextFingerprint(secret));
    });

    it('records nothing when the prompt is unchanged', () => {
      expect(diffLakeConfig(lake({ systemPrompt: secret }), lake({ systemPrompt: secret }))).toEqual([]);
    });

    it('records nothing for a whitespace-only re-save, matching every read path', () => {
      expect(diffLakeConfig(lake({ systemPrompt: secret }), lake({ systemPrompt: `  ${secret}  ` }))).toEqual([]);
    });

    it('records a set and a clear as fingerprint presence moving', () => {
      const [set] = diffLakeConfig(lake(), lake({ systemPrompt: secret }));
      expect(set.beforeFingerprint?.present).toBe(false);
      expect(set.afterFingerprint?.present).toBe(true);

      const [cleared] = diffLakeConfig(lake({ systemPrompt: secret }), lake({ systemPrompt: '' }));
      expect(cleared.beforeFingerprint?.present).toBe(true);
      expect(cleared.afterFingerprint?.present).toBe(false);
    });

    // A revert should be legible from the history alone, without either version being stored.
    it('gives an edit-and-revert the same fingerprint it started with', () => {
      const [away] = diffLakeConfig(lake({ systemPrompt: 'v1' }), lake({ systemPrompt: 'v2' }));
      const [back] = diffLakeConfig(lake({ systemPrompt: 'v2' }), lake({ systemPrompt: 'v1' }));
      expect(back.afterFingerprint?.hash).toBe(away.beforeFingerprint?.hash);
    });
  });
});

describe('ownershipChange', () => {
  it('records the move on the derived field, since no document field carries it', () => {
    expect(ownershipChange(['alice'], 'bob')).toEqual({
      field: 'effectiveOwnerUserId',
      kind: 'literal',
      before: 'alice',
      after: 'bob',
    });
  });

  it('joins several prior owners rather than dropping all but one', () => {
    expect(ownershipChange(['alice', 'carol'], 'bob')?.before).toBe('alice,carol');
  });

  it('omits `before` for a lake that had no resolvable owner', () => {
    const change = ownershipChange([], 'bob');
    expect(change).toEqual({ field: 'effectiveOwnerUserId', kind: 'literal', after: 'bob' });
  });

  it('returns null when ownership did not actually move', () => {
    expect(ownershipChange(['alice'], 'alice')).toBeNull();
  });
});

describe('access-gate fields do not trim', () => {
  // The gate predicate every read path runs is lakeMatchesAccess, whose test is raw truthiness:
  // `!!lake.requiredUserTag`. `!!' '` is true, so a whitespace-only tag is a LIVE gate nobody can
  // satisfy, while '' is no gate at all. Trimming both to "unset" made the audit blind to clearing
  // a stuck whitespace gate - the single write this feature exists to catch.
  it('records clearing a whitespace-only user tag, which is a live gate rather than an empty one', () => {
    const changes = diffLakeConfig({ requiredUserTag: ' ' }, { requiredUserTag: '' });

    expect(changes).toEqual([{ field: 'requiredUserTag', kind: 'literal', before: ' ' }]);
  });

  it('records setting a whitespace-only entitlement, since it starts gating immediately', () => {
    const changes = diffLakeConfig({}, { requiredEntitlement: ' ' });

    expect(changes).toEqual([{ field: 'requiredEntitlement', kind: 'literal', after: ' ' }]);
  });

  it('still records nothing when clearing a gate that was already truly empty', () => {
    expect(diffLakeConfig({ requiredUserTag: '' }, { requiredUserTag: '' })).toEqual([]);
    expect(diffLakeConfig({}, { requiredUserTag: '' })).toEqual([]);
  });

  // Non-gate free text keeps trimming: a whitespace-only description is empty for every reader.
  it('still trims a non-gate field, where whitespace really is absence', () => {
    expect(diffLakeConfig({ description: ' ' }, { description: '' })).toEqual([]);
  });
});

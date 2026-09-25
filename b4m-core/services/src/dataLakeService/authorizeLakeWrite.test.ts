import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingScopeLevel, type IScopedSetting, type ScopeRef } from '@bike4mind/common';
import { BadRequestError, invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import {
  assertBatchBelongsToLake,
  assertCanWriteDataLakeTags,
  assertCanWriteStaticRegistryTags,
  assertMetaTagsMatchLake,
  canManageLake,
  extractDataLakeMetaTags,
  extractStaticRegistryPrefixedTags,
} from './authorizeLakeWrite';

// Both settings caches are module-level and would otherwise leak one test's platform table into
// the next, resolving every lever to a coded default.
beforeEach(() => {
  invalidateSettingsCache();
  invalidateScopedSettingsCache();
});

const LAKE = {
  id: 'lake-1',
  createdByUserId: 'lake-creator',
  datalakeTag: 'datalake:orga:acme-2026',
  fileTagPrefix: 'acme:',
};

const dbWith = (lake: unknown) =>
  ({
    db: { dataLakes: { findByDatalakeTag: vi.fn(async () => lake) } },
  }) as never;

/**
 * Owning the FILE is not a route into the lake's manage decision, and these pin that so a future
 * "but the user owns the file" shortcut cannot be added without turning one of them red.
 *
 * A probe cannot tell the two apart: an admin who also owns a file gets through either way. The
 * structural answer is that `ManageActor` is `Pick<AccessContext, 'userId' | 'isAdmin'>`, so no
 * file and no ownership signal reaches the predicate at all - it decides on role and lake
 * creator, and there is nothing else for it to decide on.
 */
describe('canManageLake - file ownership is not an input', () => {
  it('refuses a non-admin who is not the lake creator, whatever they own elsewhere', () => {
    // Named as the file's owner to make the claim explicit; the predicate takes no file, so this
    // is the whole of what it can see about them.
    const fileOwner = { userId: 'file-owner', isAdmin: false };

    expect(canManageLake(LAKE, fileOwner)).toBe(false);
  });

  it('grants the lake creator', () => {
    expect(canManageLake(LAKE, { userId: 'lake-creator', isAdmin: false })).toBe(true);
  });

  it('grants an admin by role, not by any ownership they happen to hold', () => {
    // The disambiguation: this actor owns nothing and is not the creator. Only isAdmin is left,
    // so an admin getting through is the role arm firing and cannot be anything else.
    expect(canManageLake(LAKE, { userId: 'some-admin', isAdmin: true })).toBe(true);
  });

  it('fails closed when neither the actor nor the lake carries an identity', () => {
    // Without the truthiness guards, undefined === undefined would grant a synthetic fallback
    // lake to an actor with no userId.
    expect(canManageLake({ createdByUserId: undefined as unknown as string }, { userId: '', isAdmin: false })).toBe(
      false
    );
  });
});

describe('assertCanWriteDataLakeTags - the same rule at the write gate', () => {
  it('rejects the file owner applying a meta-tag for a lake they did not create', async () => {
    await expect(
      assertCanWriteDataLakeTags({ userId: 'file-owner', isAdmin: false }, [LAKE.datalakeTag], dbWith(LAKE))
    ).rejects.toThrow("You do not have permission to change this data lake's files");
  });

  it('accepts the lake creator', async () => {
    await expect(
      assertCanWriteDataLakeTags({ userId: 'lake-creator', isAdmin: false }, [LAKE.datalakeTag], dbWith(LAKE))
    ).resolves.toBeUndefined();
  });

  it('rejects a meta-tag that resolves to no lake', async () => {
    await expect(
      assertCanWriteDataLakeTags({ userId: 'lake-creator', isAdmin: false }, [LAKE.datalakeTag], dbWith(null))
    ).rejects.toThrow("You do not have permission to change this data lake's files");
  });

  it('ignores ordinary tags, so an unrelated write never reaches a lake lookup', async () => {
    const adapters = dbWith(LAKE) as unknown as { db: { dataLakes: { findByDatalakeTag: ReturnType<typeof vi.fn> } } };

    await assertCanWriteDataLakeTags({ userId: 'file-owner', isAdmin: false }, ['notes', 'acme:q1'], adapters as never);

    expect(adapters.db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
  });

  // A STATIC REGISTRY lake's meta-tag (e.g. datalake:opti-knowledge, the hardcoded fixture -
  // never an env-sourced premium entry) has no owning document: findByDatalakeTag always returns
  // null for it. Without its own arm, this gate would refuse EVERY write into a static lake,
  // including the platform-admin ingest scripts that are the only supported way to populate one.
  describe('static registry lakes (no owning document)', () => {
    it('accepts an admin with no DB lookup at all', async () => {
      const adapters = dbWith(null) as unknown as {
        db: { dataLakes: { findByDatalakeTag: ReturnType<typeof vi.fn> } };
      };

      await expect(
        assertCanWriteDataLakeTags(
          { userId: 'ingest-admin', isAdmin: true },
          ['datalake:opti-knowledge'],
          adapters as never
        )
      ).resolves.toBeUndefined();
      expect(adapters.db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
    });

    it('refuses a non-admin, without ever finding a document to say so', async () => {
      await expect(
        assertCanWriteDataLakeTags({ userId: 'someone', isAdmin: false }, ['datalake:opti-knowledge'], dbWith(null))
      ).rejects.toThrow("Only an admin can change this data lake's files");
    });
  });
});

/**
 * Settings stores backing the resolver. `platform` supplies the platform row for each key; the
 * scoped overlay is left empty unless a test wires one, which is the default (report-only) install.
 */
const settingsDb = (platform: Record<string, string>, overrides: Array<Partial<IScopedSetting>> = []) => ({
  adminSettings: {
    findBySettingNames: vi.fn(async (names: string[]) =>
      names.filter(n => platform[n] != null).map(n => ({ settingName: n, settingValue: platform[n] }))
    ),
    findAll: vi.fn(async () =>
      Object.entries(platform).map(([settingName, settingValue]) => ({ settingName, settingValue }))
    ),
  },
  scopedSettings: {
    findOverrides: vi.fn(
      async (scopes: ScopeRef[], names: string[]) =>
        overrides.filter(
          o =>
            names.includes(o.settingName as string) &&
            scopes.some(s => s.scopeLevel === o.scopeLevel && s.scopeId === o.scopeId)
        ) as IScopedSetting[]
    ),
  },
});

const ADMIN = { userId: 'admin-1', isAdmin: true, administeredOrgIds: [] };

const lakeDoc = (origin: 'curated' | 'connector-fed') => ({
  id: 'lake-1',
  name: 'Acme Docs',
  datalakeTag: 'datalake:acme-docs',
  createdByUserId: 'owner-1',
  organizationId: 'org-1',
  origin,
});

const dbFor = (
  origin: 'curated' | 'connector-fed',
  platform: Record<string, string> = {},
  overrides: Array<Partial<IScopedSetting>> = []
) => ({
  dataLakes: { findByDatalakeTag: vi.fn(async () => lakeDoc(origin)) },
  ...settingsDb(platform, overrides),
});

/** An `EnforceLakeOriginOnIngest` override at the LAKE rung - the rung the setting's own
 * description calls the one that matters, since it is resolved through `scopeForLake`. */
const originOverrideForLake = (lakeId: string, value: 'true' | 'false'): Partial<IScopedSetting> => ({
  scopeLevel: SettingScopeLevel.Lake as IScopedSetting['scopeLevel'],
  scopeId: lakeId,
  settingName: 'EnforceLakeOriginOnIngest',
  settingValue: value,
});

describe('assertCanWriteDataLakeTags unattended arm', () => {
  it('refuses an unattended write to a curated lake', async () => {
    await expect(
      assertCanWriteDataLakeTags(ADMIN, ['datalake:acme-docs'], { db: dbFor('curated'), unattended: true })
    ).rejects.toThrow(BadRequestError);
  });

  it('allows an unattended write to a connector-fed lake', async () => {
    await expect(
      assertCanWriteDataLakeTags(ADMIN, ['datalake:acme-docs'], { db: dbFor('connector-fed'), unattended: true })
    ).resolves.toBeUndefined();
  });

  it('allows a human write to a curated lake (flag omitted)', async () => {
    await expect(
      assertCanWriteDataLakeTags(ADMIN, ['datalake:acme-docs'], { db: dbFor('curated') })
    ).resolves.toBeUndefined();
  });

  it('resolves no setting at all when the flag is omitted', async () => {
    const db = dbFor('curated');
    await assertCanWriteDataLakeTags(ADMIN, ['datalake:acme-docs'], { db });
    // The eight human callers must pay no new read - platform and scoped alike.
    expect(db.adminSettings.findAll).not.toHaveBeenCalled();
    expect(db.scopedSettings.findOverrides).not.toHaveBeenCalled();
  });

  it('allows an unattended write when EnforceLakeOriginOnIngest is off at the platform rung', async () => {
    const db = dbFor('curated', { EnforceLakeOriginOnIngest: 'false' });
    await expect(
      assertCanWriteDataLakeTags(ADMIN, ['datalake:acme-docs'], { db, unattended: true })
    ).resolves.toBeUndefined();
  });

  it('lets an unattended write through when EnforceLakeOriginOnIngest is overridden off at the LAKE rung', async () => {
    // Pins scopeForLake(lake), not just the platform default: a regression that resolved a
    // lake-less scope would leave every per-lake opt-out silently inert while this test's
    // sibling above (a platform-rung override) stayed green.
    const db = dbFor('curated', {}, [originOverrideForLake('lake-1', 'false')]);
    await expect(
      assertCanWriteDataLakeTags(ADMIN, ['datalake:acme-docs'], { db, unattended: true })
    ).resolves.toBeUndefined();
  });

  it('keeps checking after the first lake is exempted, refusing on a later curated lake', async () => {
    // Connector-fed tag ordered first: a loop that stopped at the first exemption instead of
    // continuing to check the rest would resolve this write, not reject it.
    const exemptTag = 'datalake:exempt-lake';
    const curatedTag = 'datalake:curated-lake';
    const lakesByTag: Record<string, ReturnType<typeof lakeDoc>> = {
      [exemptTag]: { ...lakeDoc('connector-fed'), id: 'lake-exempt', datalakeTag: exemptTag },
      [curatedTag]: { ...lakeDoc('curated'), id: 'lake-curated', datalakeTag: curatedTag },
    };
    const db = {
      dataLakes: { findByDatalakeTag: vi.fn(async (tag: string) => lakesByTag[tag]) },
      ...settingsDb({}),
    };

    await expect(assertCanWriteDataLakeTags(ADMIN, [exemptTag, curatedTag], { db, unattended: true })).rejects.toThrow(
      BadRequestError
    );
  });
});

describe('assertBatchBelongsToLake - the batch decides which lake its files join', () => {
  const MISMATCH = 'This upload must name the data lake its batch belongs to';

  it('accepts a batch bound to the lake the request resolved', () => {
    expect(() => assertBatchBelongsToLake({ dataLakeId: LAKE.id }, LAKE)).not.toThrow();
  });

  it('refuses a batch bound to a different lake', () => {
    expect(() => assertBatchBelongsToLake({ dataLakeId: 'lake-2' }, LAKE)).toThrow(MISMATCH);
  });

  it('refuses a request that resolved no lake at all', () => {
    // Otherwise the files land in this lake's batch while joining no lake.
    expect(() => assertBatchBelongsToLake({ dataLakeId: LAKE.id }, undefined)).toThrow(MISMATCH);
  });

  it('names the batch, not the caller, when the batch carries no lake binding', () => {
    // The caller did name a lake here, so telling them to name one would be a lie.
    expect(() => assertBatchBelongsToLake({ dataLakeId: undefined as unknown as string }, LAKE)).toThrow(
      'This batch is not attached to a data lake'
    );
  });
});

describe('assertMetaTagsMatchLake - the tag must name the lake being written to', () => {
  const MISMATCH = 'A data lake tag on these files names a different data lake';

  it('rejects a meta-tag for another lake, even one the caller may write to', () => {
    // The write gate passes this actor for both lakes (admin), so the disagreement itself is
    // the only thing left to catch it.
    expect(() => assertMetaTagsMatchLake(LAKE, ['datalake:orgb:other-lake'])).toThrow(MISMATCH);
  });

  it('accepts the lake own tag whatever case it arrives in', () => {
    expect(() => assertMetaTagsMatchLake(LAKE, ['DataLake:OrgA:Acme-2026', 'acme:legal'])).not.toThrow();
  });

  it("accepts its own tag when the LAKE's stored tag is the mixed-case side", () => {
    // Nothing lowercases `datalakeTag` on the way into Mongo, so a row can hold mixed case; only
    // folding the payload would refuse that lake its own tag.
    expect(() => assertMetaTagsMatchLake({ datalakeTag: 'DataLake:OrgA:Acme-2026' }, [LAKE.datalakeTag])).not.toThrow();
  });

  it('accepts a payload with no meta-tag at all', () => {
    expect(() => assertMetaTagsMatchLake(LAKE, [])).not.toThrow();
    expect(() => assertMetaTagsMatchLake(LAKE, ['acme:legal', null, 42])).not.toThrow();
  });

  it('refuses every meta-tag when the lake has no tag of its own', () => {
    expect(() => assertMetaTagsMatchLake({ datalakeTag: undefined as unknown as string }, [LAKE.datalakeTag])).toThrow(
      MISMATCH
    );
  });
});

describe('extractDataLakeMetaTags', () => {
  it('lowercases, dedupes, and drops non-string entries', () => {
    expect(
      extractDataLakeMetaTags(['DataLake:OrgA:Acme-2026', 'datalake:orga:acme-2026', 'notes', null, undefined, 42])
    ).toEqual(['datalake:orga:acme-2026']);
  });
});

// 'opti:' is the hardcoded opti-knowledge entry in DATA_LAKES, present regardless of the
// PREMIUM_DATA_LAKES env var - the one registry prefix these tests can rely on in any environment.
describe('extractStaticRegistryPrefixedTags', () => {
  it('finds a tag under a registry prefix', () => {
    expect(extractStaticRegistryPrefixedTags(['opti:report', 'notes'])).toEqual(['opti:report']);
  });

  it('is case-sensitive, matching the OPEN read arm which builds an unflagged regex', () => {
    expect(extractStaticRegistryPrefixedTags(['Opti:report'])).toEqual([]);
  });

  it('matches a bare prefix with no suffix, unlike satisfiesTagPrefix', () => {
    // The OPEN prefix arm's regex has no suffix-length requirement, so a bare 'opti:' still
    // leaks through it and must be caught here too.
    expect(extractStaticRegistryPrefixedTags(['opti:'])).toEqual(['opti:']);
  });

  it('drops non-string entries and tags matching no registry prefix', () => {
    expect(extractStaticRegistryPrefixedTags(['notes', null, undefined, 42, 'acme:legal'])).toEqual([]);
  });
});

describe('assertCanWriteStaticRegistryTags', () => {
  it('rejects a non-admin self-applying a registry prefix', () => {
    expect(() => assertCanWriteStaticRegistryTags({ userId: 'user-1', isAdmin: false }, ['opti:report'])).toThrow(
      "Only an admin can change this data lake's files"
    );
  });

  it('accepts an admin', () => {
    expect(() => assertCanWriteStaticRegistryTags({ userId: 'admin-1', isAdmin: true }, ['opti:report'])).not.toThrow();
  });

  it('ignores tags that match no registry prefix', () => {
    expect(() =>
      assertCanWriteStaticRegistryTags({ userId: 'user-1', isAdmin: false }, ['notes', 'acme:legal'])
    ).not.toThrow();
  });
});

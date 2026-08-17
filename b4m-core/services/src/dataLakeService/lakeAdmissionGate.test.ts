import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettingScopeLevel,
  type FabFileChunkPolicyConflictLake,
  type IScopedSetting,
  type ScopeRef,
} from '@bike4mind/common';
import { BadRequestError, invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import { assertLakeAdmission, decideLakeAdmission, type AdmissionLake } from './lakeAdmissionGate';

// Both settings caches are module-level and would otherwise leak one test's platform table into
// the next, resolving every lever to a coded default.
beforeEach(() => {
  invalidateSettingsCache();
  invalidateScopedSettingsCache();
});

const MODEL = 'text-embedding-3-small'; // 8192 window, 20% buffer => hard limit 6554

const req = (name: string, effectiveRequiredTarget: number, lakeId?: string): FabFileChunkPolicyConflictLake => ({
  lakeId: lakeId === undefined ? `id-${name}` : lakeId || undefined,
  datalakeTag: `datalake:${name}`,
  name,
  requiredTarget: effectiveRequiredTarget,
  effectiveRequiredTarget,
});

const subject = (userId: string, effectiveTarget: number) => ({ member: { userId }, effectiveTarget });

const lake = (over: Partial<AdmissionLake> = {}): AdmissionLake =>
  ({
    id: 'lake-1',
    name: 'Acme Docs',
    datalakeTag: 'datalake:acme-docs',
    createdByUserId: 'owner-1',
    ...over,
  }) as AdmissionLake;

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

/** An `EnforceLakeAdmission` override turning the lever ON at one lake. */
const enforcingLake = (lakeId: string): Partial<IScopedSetting> => ({
  scopeLevel: SettingScopeLevel.Lake as IScopedSetting['scopeLevel'],
  scopeId: lakeId,
  settingName: 'EnforceLakeAdmission',
  settingValue: 'true',
});

describe('decideLakeAdmission (pure admission decision)', () => {
  it('admits when there are no requirements', () => {
    expect(decideLakeAdmission([subject('u1', 512)], [], new Set())).toEqual({ status: 'admitted' });
  });

  it('admits when every member matches every requirement', () => {
    const verdict = decideLakeAdmission([subject('u1', 512), subject('u2', 512)], [req('a', 512)], new Set());
    expect(verdict).toEqual({ status: 'admitted' });
  });

  it('quarantines a member whose target differs from the requirement', () => {
    const verdict = decideLakeAdmission([subject('u1', 512)], [req('a', 1000)], new Set());
    expect(verdict.status).toBe('quarantined');
  });

  it('stays report-only (does not enforce) when the violated lake is not in the enforcing set', () => {
    const verdict = decideLakeAdmission([subject('u1', 512)], [req('a', 1000)], new Set());
    expect(verdict.status === 'quarantined' && verdict.enforced).toBe(false);
  });

  it('enforces when the violated lake IS in the enforcing set', () => {
    const verdict = decideLakeAdmission([subject('u1', 512)], [req('a', 1000)], new Set(['id-a']));
    expect(verdict.status === 'quarantined' && verdict.enforced).toBe(true);
  });

  it('enforces if ANY violated lake enforces, even when another only reports', () => {
    const verdict = decideLakeAdmission([subject('u1', 512)], [req('a', 1000), req('b', 1500)], new Set(['id-b']));
    expect(verdict.status === 'quarantined' && verdict.enforced).toBe(true);
  });

  it('never enforces a requirement with no lakeId - a static-registry lake has no scope to set the lever at', () => {
    const verdict = decideLakeAdmission([subject('u1', 512)], [req('static', 1000, '')], new Set(['id-static']));
    expect(verdict.status === 'quarantined' && verdict.enforced).toBe(false);
  });

  it('records one violation per (member, lake) pair', () => {
    const verdict = decideLakeAdmission(
      [subject('u1', 512), subject('u2', 512)],
      [req('a', 1000), req('b', 1500)],
      new Set()
    );
    expect(verdict.status === 'quarantined' && verdict.violations).toHaveLength(4);
  });

  it('quarantines only the member that violates, leaving a conforming member out of the violations', () => {
    const verdict = decideLakeAdmission([subject('good', 1000), subject('bad', 512)], [req('a', 1000)], new Set());
    expect(verdict.status === 'quarantined' && verdict.violations.map(v => v.member.userId)).toEqual(['bad']);
  });

  it('names the lake, its required target and the actual target in the message', () => {
    const verdict = decideLakeAdmission([subject('u1', 512)], [req('Acme Docs', 1000)], new Set());
    expect(verdict.status === 'quarantined' && verdict.message).toContain('Acme Docs');
    expect(verdict.status === 'quarantined' && verdict.message).toContain('1000');
    expect(verdict.status === 'quarantined' && verdict.message).toContain('512');
  });

  it('describes only the BLOCKING lake when some violated lakes merely report', () => {
    const verdict = decideLakeAdmission(
      [subject('u1', 512)],
      [req('reports', 1000), req('blocks', 1500)],
      new Set(['id-blocks'])
    );
    expect(verdict.status === 'quarantined' && verdict.message).toContain('blocks');
    expect(verdict.status === 'quarantined' && verdict.message).not.toContain('reports');
  });
});

describe('assertLakeAdmission', () => {
  it('does no settings work at all when no lake declares a passage policy', async () => {
    const db = settingsDb({});
    await expect(assertLakeAdmission([lake()], [{ userId: 'u1' }], { db })).resolves.toEqual({ status: 'admitted' });
    expect(db.adminSettings.findBySettingNames).not.toHaveBeenCalled();
    expect(db.scopedSettings.findOverrides).not.toHaveBeenCalled();
  });

  it('does no settings work when nothing is being admitted', async () => {
    const db = settingsDb({});
    await expect(assertLakeAdmission([lake({ requiredPassageTokenTarget: 1000 })], [], { db })).resolves.toEqual({
      status: 'admitted',
    });
    expect(db.adminSettings.findBySettingNames).not.toHaveBeenCalled();
  });

  it('admits a chunked file whose recorded target matches the requirement', async () => {
    const db = settingsDb({ defaultEmbeddingModel: MODEL });
    const verdict = await assertLakeAdmission(
      [lake({ requiredPassageTokenTarget: 1000 })],
      [{ userId: 'u1', chunkedPassageTokenTarget: 1000 }],
      { db }
    );
    expect(verdict).toEqual({ status: 'admitted' });
  });

  it('grades a chunked file on its RECORDED target, not on what the owner policy predicts', async () => {
    // Owner policy says 1000 (which would conform); the file's chunks were actually built at 512.
    const db = settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '1000' });
    const verdict = await assertLakeAdmission(
      [lake({ requiredPassageTokenTarget: 1000 })],
      [{ userId: 'u1', chunkedPassageTokenTarget: 512 }],
      { db }
    );
    expect(verdict.status).toBe('quarantined');
  });

  it('PREDICTS from the owner chunk policy for a file that has not been chunked', async () => {
    const db = settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '1000' });
    const verdict = await assertLakeAdmission([lake({ requiredPassageTokenTarget: 1000 })], [{ userId: 'u1' }], { db });
    expect(verdict).toEqual({ status: 'admitted' });
  });

  it('refuses a predicted mismatch before any file exists - the pre-upload gate', async () => {
    const db = settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '512' }, [enforcingLake('lake-1')]);
    await expect(
      assertLakeAdmission([lake({ requiredPassageTokenTarget: 1000 })], [{ userId: 'u1' }], { db })
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('allows the write and returns the verdict when the lever is off (report-only default)', async () => {
    const db = settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '512' });
    const verdict = await assertLakeAdmission([lake({ requiredPassageTokenTarget: 1000 })], [{ userId: 'u1' }], { db });
    expect(verdict.status).toBe('quarantined');
    expect(verdict.status === 'quarantined' && verdict.enforced).toBe(false);
  });

  it('logs the report-only verdict so a smoke test can tell it fired from never having run', async () => {
    const db = settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '512' });
    const warn = vi.fn();
    await assertLakeAdmission([lake({ requiredPassageTokenTarget: 1000 })], [{ userId: 'u1' }], {
      db,
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('report-only'));
  });

  it('logs a clean pass too, so "checked and admissible" is distinguishable from "never checked"', async () => {
    const db = settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '1000' });
    const log = vi.fn();
    await assertLakeAdmission([lake({ requiredPassageTokenTarget: 1000 })], [{ userId: 'u1' }], {
      db,
      logger: { log },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('satisfy'));
  });

  it('resolves the owner chunk policy once for several files sharing an owner', async () => {
    const db = settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '1000' });
    await assertLakeAdmission(
      [lake({ requiredPassageTokenTarget: 1000 })],
      [{ userId: 'u1' }, { userId: 'u1' }, { userId: 'u1' }],
      { db }
    );
    // Asserted on the overlay store, which is queried once per resolution and is not memoized by
    // the platform-settings cache: one DefaultChunkSize resolution for the shared owner (not three)
    // plus one EnforceLakeAdmission resolution for the lake.
    const resolvedKeys = db.scopedSettings.findOverrides.mock.calls.map(([, names]) => (names as string[]).join(','));
    expect(resolvedKeys).toEqual(['DefaultChunkSize', 'EnforceLakeAdmission']);
  });

  it('uses a caller-supplied embedding model rather than reading the platform setting', async () => {
    const db = settingsDb({ DefaultChunkSize: '1000' });
    const verdict = await assertLakeAdmission([lake({ requiredPassageTokenTarget: 1000 })], [{ userId: 'u1' }], {
      db,
      embeddingModel: MODEL,
    });
    expect(verdict).toEqual({ status: 'admitted' });
    const modelCalls = db.adminSettings.findBySettingNames.mock.calls.filter(([names]) =>
      (names as string[]).includes('defaultEmbeddingModel')
    );
    expect(modelCalls).toHaveLength(0);
  });

  it('falls back to the coded chunk default when the owner policy is unreadable, and grades against that', async () => {
    // No DefaultChunkSize row at all: the resolver degrades to DEFAULT_PASSAGE_TOKEN_TARGET (512)
    // rather than throwing, and the contract is still graded - a missing lever must not read as
    // "admissible by default".
    const db = settingsDb({ defaultEmbeddingModel: MODEL });
    const verdict = await assertLakeAdmission([lake({ requiredPassageTokenTarget: 1000 })], [{ userId: 'u1' }], { db });
    expect(verdict.status).toBe('quarantined');
  });

  it('resolves the lever per lake, so one enforcing lake blocks while a reporting one does not', async () => {
    const db = settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '512' }, [enforcingLake('lake-strict')]);
    const lakes = [
      lake({ id: 'lake-relaxed', name: 'Relaxed', requiredPassageTokenTarget: 1000 }),
      lake({ id: 'lake-strict', name: 'Strict', datalakeTag: 'datalake:strict', requiredPassageTokenTarget: 1500 }),
    ];
    await expect(assertLakeAdmission(lakes, [{ userId: 'u1' }], { db })).rejects.toThrow(/Strict/);
  });
});

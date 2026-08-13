import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  IScopedSetting,
  MIN_PASSAGE_TOKEN_TARGET,
  ScopeRef,
  SERVE_CHUNK_CHARS_CEILING,
  SERVE_CHUNK_CHARS_FLOOR,
  SettingScope,
  SettingScopeLevel,
  deriveServeCharBudget,
} from '@bike4mind/common';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import { resolveSearchBudgets } from './resolveSearchBudgets';

function makeDb(
  platform: Record<string, string>,
  overrides: Array<Partial<IScopedSetting>> = [],
  opts?: { throwOverrides?: boolean }
) {
  return {
    adminSettings: {
      findAll: async () =>
        Object.entries(platform).map(([settingName, settingValue]) => ({ settingName, settingValue })),
      findBySettingNames: async (names: string[]) =>
        names.filter(n => platform[n] != null).map(n => ({ settingName: n, settingValue: platform[n] })),
    },
    scopedSettings: {
      findOverrides: async (scopes: ScopeRef[], names: string[]) => {
        if (opts?.throwOverrides) throw new Error('overlay down');
        return overrides.filter(
          o =>
            names.includes(o.settingName as string) &&
            scopes.some(s => s.scopeLevel === o.scopeLevel && s.scopeId === o.scopeId)
        ) as IScopedSetting[];
      },
    },
  };
}

/**
 * The full Logger surface, not just `warn`: the settings cache this resolver reads through calls
 * `debug` on whatever logger first constructs it, and a partial stub makes that throw - which the
 * resolver then swallows as a settings outage, so every case silently returns coded defaults and the
 * test looks like a derivation bug instead of a stub bug.
 */
function loggerStub() {
  return {
    warn: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  } as unknown as Parameters<typeof resolveSearchBudgets>[1] & { warn: ReturnType<typeof vi.fn> };
}

const scope: SettingScope = { organizationId: 'o1', owner: { id: 'u1', type: CreditHolderType.User }, lakeId: 'l1' };

/** No DefaultChunkSize row configured, so the serve budget derives from the chunker's own default. */
const DEFAULT_SERVE_CHARS = deriveServeCharBudget(DEFAULT_PASSAGE_TOKEN_TARGET).maxChunkChars;

beforeEach(() => {
  vi.clearAllMocks();
  // Both caches are module-level globals, so without this a later case reads the previous case's
  // stored values and passes or fails for the wrong reason.
  invalidateSettingsCache();
  invalidateScopedSettingsCache();
});

describe('resolveSearchBudgets - platform path (unchanged behavior)', () => {
  it('uses coded defaults when no rows exist', async () => {
    const budgets = await resolveSearchBudgets(makeDb({}));
    expect(budgets).toEqual({
      maxFiles: DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
      maxChunks: DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
      maxChunkChars: DEFAULT_SERVE_CHARS,
    });
  });

  it('uses configured platform values', async () => {
    const budgets = await resolveSearchBudgets(
      makeDb({ dataLakeSearchMaxFiles: '10', dataLakeSearchMaxChunks: '200' })
    );
    expect(budgets).toEqual({ maxFiles: 10, maxChunks: 200, maxChunkChars: DEFAULT_SERVE_CHARS });
  });

  it('floors a non-integer and ignores an unusable value with a warning', async () => {
    const logger = loggerStub();
    // maxChunks '0' is < 1 (unusable -> default + warn); maxFiles '7.9' floors to 7.
    const budgets = await resolveSearchBudgets(
      makeDb({ dataLakeSearchMaxFiles: '7.9', dataLakeSearchMaxChunks: '0' }),
      logger
    );
    expect(budgets.maxFiles).toBe(7);
    expect(budgets.maxChunks).toBe(DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unusable maxChunks'));
  });

  it('takes the platform path when a scope is passed but no scoped store is wired', async () => {
    const db = makeDb({ dataLakeSearchMaxFiles: '3000' });
    const budgets = await resolveSearchBudgets({ adminSettings: db.adminSettings }, undefined, scope);
    expect(budgets.maxFiles).toBe(3000);
    expect(budgets.maxChunkChars).toBe(DEFAULT_SERVE_CHARS);
  });
});

describe('resolveSearchBudgets - scoped path', () => {
  it('a narrower override tightens the budget below the platform ceiling', async () => {
    const db = makeDb({ dataLakeSearchMaxFiles: '3000', dataLakeSearchMaxChunks: '50000' }, [
      {
        scopeLevel: SettingScopeLevel.Lake,
        scopeId: 'l1',
        settingName: 'dataLakeSearchMaxFiles',
        settingValue: '1000',
      },
    ]);
    const budgets = await resolveSearchBudgets(db, undefined, scope);
    expect(budgets.maxFiles).toBe(1000); // lake override
    expect(budgets.maxChunks).toBe(50000); // no override -> platform
  });

  it('falls back to the platform path if scoped resolution throws', async () => {
    const logger = loggerStub();
    const db = makeDb({ dataLakeSearchMaxFiles: '3000' }, [], { throwOverrides: true });
    const budgets = await resolveSearchBudgets(db, logger, scope);
    expect(budgets.maxFiles).toBe(3000);
    // The fallback must carry the serve budget too, or the scoped path degrades into an unclipped one.
    expect(budgets.maxChunkChars).toBe(DEFAULT_SERVE_CHARS);
  });

  it('carries the same derived serve budget as the platform path', async () => {
    // 300 tokens derives 1800 chars: a number neither the deleted 1200 constant nor the default
    // policy (3072) can produce, so a scoped branch that hardcoded either one fails here.
    const db = makeDb({ DefaultChunkSize: '300', dataLakeSearchMaxFiles: '3000' }, [
      { scopeLevel: SettingScopeLevel.Lake, scopeId: 'l1', settingName: 'dataLakeSearchMaxFiles', settingValue: '25' },
    ]);

    const scoped = await resolveSearchBudgets(db, undefined, scope);
    const platform = await resolveSearchBudgets(db);

    expect(scoped.maxFiles).toBe(25); // proves the scoped branch actually ran
    expect(scoped.maxChunkChars).toBe(deriveServeCharBudget(300).maxChunkChars);
    expect(scoped.maxChunkChars).toBe(platform.maxChunkChars);
    expect(scoped.maxChunkChars).not.toBe(SERVE_CHUNK_CHARS_FLOOR);
    expect(scoped.maxChunkChars).not.toBe(DEFAULT_SERVE_CHARS);
  });

  it('does not let a lake rung override the chunk policy - that is not a lever yet', async () => {
    // DefaultChunkSize declares no scope.settableAt, so an override row for it must be inert:
    // #1661 derives the serve budget, it does not add an org/lake chunk-policy rung (that is #1662).
    const db = makeDb({ DefaultChunkSize: '300' }, [
      { scopeLevel: SettingScopeLevel.Lake, scopeId: 'l1', settingName: 'DefaultChunkSize', settingValue: '6554' },
    ]);

    const budgets = await resolveSearchBudgets(db, undefined, scope);

    expect(budgets.maxChunkChars).toBe(deriveServeCharBudget(300).maxChunkChars);
    expect(budgets.maxChunkChars).not.toBe(SERVE_CHUNK_CHARS_CEILING);
  });
});

describe('resolveSearchBudgets - serve budget', () => {
  it('derives the serve budget from the chunk policy, not from a cap of its own', async () => {
    const logger = loggerStub();

    const budgets = await resolveSearchBudgets(makeDb({ DefaultChunkSize: '1000' }), logger);

    expect(budgets.maxChunkChars).toBe(deriveServeCharBudget(1000).maxChunkChars);
    // The invariant the issue asks for: a full chunk fits in what the serve path will emit.
    expect(budgets.maxChunkChars).toBeGreaterThan(SERVE_CHUNK_CHARS_FLOOR);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to the chunker default when no chunk size is configured, silently', async () => {
    const logger = loggerStub();

    const budgets = await resolveSearchBudgets(makeDb({}), logger);

    expect(budgets.maxChunkChars).toBe(DEFAULT_SERVE_CHARS);
    // An unset setting is the normal case, so it must not look like a misconfiguration.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and uses the chunker default for a set-but-unusable chunk size', async () => {
    const logger = loggerStub();

    const budgets = await resolveSearchBudgets(makeDb({ DefaultChunkSize: 'not-a-number' }), logger);

    expect(budgets.maxChunkChars).toBe(DEFAULT_SERVE_CHARS);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DefaultChunkSize'));
  });

  it('never serves below the historical cap, however small the configured chunk is', async () => {
    const budgets = await resolveSearchBudgets(makeDb({ DefaultChunkSize: String(MIN_PASSAGE_TOKEN_TARGET) }));

    expect(budgets.maxChunkChars).toBe(SERVE_CHUNK_CHARS_FLOOR);
  });

  it('warns that clipping is expected when the ceiling leaves the cap below the chunk size', async () => {
    const logger = loggerStub();

    // 6554 tokens is what the pre-passage-granularity chunker produced; those chunks still exist.
    const budgets = await resolveSearchBudgets(makeDb({ DefaultChunkSize: '6554' }), logger);

    expect(budgets.maxChunkChars).toBe(SERVE_CHUNK_CHARS_CEILING);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('6554'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('clipped'));
  });

  it('still resolves the scan budgets alongside the serve budget', async () => {
    const budgets = await resolveSearchBudgets(
      makeDb({ dataLakeSearchMaxFiles: '10', dataLakeSearchMaxChunks: '250', DefaultChunkSize: '512' })
    );

    expect(budgets).toEqual({
      maxFiles: 10,
      maxChunks: 250,
      maxChunkChars: deriveServeCharBudget(512).maxChunkChars,
    });
  });

  it('returns a usable serve budget when the settings read throws', async () => {
    const logger = loggerStub();
    const exploding = {
      adminSettings: {
        findBySettingNames: vi.fn(async () => {
          throw new Error('settings outage');
        }),
        findAll: vi.fn(async () => {
          throw new Error('settings outage');
        }),
      },
    } as unknown as Parameters<typeof resolveSearchBudgets>[0];

    const budgets = await resolveSearchBudgets(exploding, logger);

    // The never-throws contract has to cover the new field too, or the serve path gets undefined and
    // clips to nothing at exactly the moment settings are already broken.
    expect(budgets).toEqual({
      maxFiles: DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
      maxChunks: DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
      maxChunkChars: deriveServeCharBudget(undefined).maxChunkChars,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});

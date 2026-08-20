import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  IScopedSetting,
  KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
  KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT,
  KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
  MIN_PASSAGE_TOKEN_TARGET,
  ScopeRef,
  SERVE_CHUNK_CHARS_CEILING,
  SERVE_CHUNK_CHARS_FLOOR,
  SettingScope,
  SettingScopeLevel,
  deriveServeCharBudget,
} from '@bike4mind/common';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import { resetServeCeilingWarnLimiter, resolveSearchBudgets } from './resolveSearchBudgets';

/** The three #1955 kb* fields at their coded, behavior-preserving defaults. */
const KB_DEFAULTS = {
  kbDefaultResults: KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
  kbResultTokenBudget: KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
  kbMinRelevance: KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT / 100,
};

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
  // The ceiling warn is throttled by module state, so without this a later case sees it already spent.
  resetServeCeilingWarnLimiter();
});

describe('resolveSearchBudgets - platform path (unchanged behavior)', () => {
  it('uses coded defaults when no rows exist', async () => {
    const budgets = await resolveSearchBudgets(makeDb({}));
    expect(budgets).toEqual({
      maxFiles: DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
      maxChunks: DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
      maxChunkChars: DEFAULT_SERVE_CHARS,
      ...KB_DEFAULTS,
    });
  });

  it('uses configured platform values', async () => {
    const budgets = await resolveSearchBudgets(
      makeDb({ dataLakeSearchMaxFiles: '10', dataLakeSearchMaxChunks: '200' })
    );
    expect(budgets).toEqual({ maxFiles: 10, maxChunks: 200, maxChunkChars: DEFAULT_SERVE_CHARS, ...KB_DEFAULTS });
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

  it('warns once per chunk target, not on every search', async () => {
    const logger = loggerStub();
    const db = makeDb({ DefaultChunkSize: '6554' });
    const ceilingWarn = expect.stringContaining('exceeds the per-passage serve ceiling');

    await resolveSearchBudgets(db, logger);
    await resolveSearchBudgets(db, logger);
    await resolveSearchBudgets(db, logger);

    // Search runs up to MAX_SEARCHES times a turn for every user, so a per-call warn buries the
    // signal in its own repetition. The fact is about the config, not about any one request.
    expect(logger.warn.mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('ceiling'))).toHaveLength(
      1
    );
    expect(logger.warn).toHaveBeenCalledWith(ceilingWarn);
  });

  it('warns again when the chunk target changes to another ceiling-bound value', async () => {
    const logger = loggerStub();

    await resolveSearchBudgets(makeDb({ DefaultChunkSize: '6554' }), logger);
    invalidateSettingsCache();
    await resolveSearchBudgets(makeDb({ DefaultChunkSize: '7000' }), logger);

    // Throttling must not silence a NEW misconfiguration - that would be the "silent" failure this
    // whole change removes, reintroduced in the warn itself.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('6554'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('7000'));
  });

  it('still resolves the scan budgets alongside the serve budget', async () => {
    const budgets = await resolveSearchBudgets(
      makeDb({ dataLakeSearchMaxFiles: '10', dataLakeSearchMaxChunks: '250', DefaultChunkSize: '512' })
    );

    expect(budgets).toEqual({
      maxFiles: 10,
      maxChunks: 250,
      maxChunkChars: deriveServeCharBudget(512).maxChunkChars,
      ...KB_DEFAULTS,
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

    // The never-throws contract has to cover the new fields too, or the serve path gets undefined and
    // clips to nothing at exactly the moment settings are already broken.
    expect(budgets).toEqual({
      maxFiles: DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
      maxChunks: DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
      maxChunkChars: deriveServeCharBudget(undefined).maxChunkChars,
      ...KB_DEFAULTS,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('resolveSearchBudgets - kb* fields (#1955)', () => {
  it('resolves configured platform values for the token budget and relevance threshold', async () => {
    const budgets = await resolveSearchBudgets(
      makeDb({ kbSearchDefaultResults: '8', kbSearchResultTokenBudget: '4000', kbSearchMinRelevancePct: '30' })
    );
    expect(budgets.kbDefaultResults).toBe(8);
    expect(budgets.kbResultTokenBudget).toBe(4000);
    expect(budgets.kbMinRelevance).toBeCloseTo(0.3);
  });

  it('honors an explicit 0 for the token budget and relevance threshold, with no warning', async () => {
    const logger = loggerStub();
    const budgets = await resolveSearchBudgets(
      makeDb({ kbSearchResultTokenBudget: '0', kbSearchMinRelevancePct: '0' }),
      logger
    );
    expect(budgets.kbResultTokenBudget).toBe(0);
    expect(budgets.kbMinRelevance).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and falls back to the coded default for a negative or non-numeric value', async () => {
    const logger = loggerStub();
    const budgets = await resolveSearchBudgets(
      makeDb({ kbSearchResultTokenBudget: '-5', kbSearchMinRelevancePct: 'not-a-number' }),
      logger
    );
    expect(budgets.kbResultTokenBudget).toBe(KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT);
    expect(budgets.kbMinRelevance).toBe(KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT / 100);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('kbSearchResultTokenBudget'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('kbSearchMinRelevancePct'));
  });

  it('a settings outage falls back to the coded constants for all three kb* fields', async () => {
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

    expect(budgets.kbDefaultResults).toBe(KB_SEARCH_DEFAULT_RESULTS_DEFAULT);
    expect(budgets.kbResultTokenBudget).toBe(KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT);
    expect(budgets.kbMinRelevance).toBe(KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT / 100);
  });

  it('an org-rung override wins over the platform value', async () => {
    const orgScope: SettingScope = {
      organizationId: 'org-1',
      owner: { id: 'org-1', type: CreditHolderType.Organization },
    };
    const db = makeDb({ kbSearchResultTokenBudget: '1000' }, [
      {
        scopeLevel: SettingScopeLevel.Organization,
        scopeId: 'org-1',
        settingName: 'kbSearchResultTokenBudget',
        settingValue: '5000',
      },
    ]);
    const budgets = await resolveSearchBudgets(db, undefined, orgScope);
    expect(budgets.kbResultTokenBudget).toBe(5000);
  });

  it('an owner-rung override wins over an org-rung override', async () => {
    const ownerScope: SettingScope = {
      organizationId: 'org-1',
      owner: { id: 'user-1', type: CreditHolderType.User },
    };
    const db = makeDb({ kbSearchMinRelevancePct: '10' }, [
      {
        scopeLevel: SettingScopeLevel.Organization,
        scopeId: 'org-1',
        settingName: 'kbSearchMinRelevancePct',
        settingValue: '20',
      },
      {
        scopeLevel: SettingScopeLevel.Owner,
        scopeId: 'user-1',
        settingName: 'kbSearchMinRelevancePct',
        settingValue: '40',
      },
    ]);
    const budgets = await resolveSearchBudgets(db, undefined, ownerScope);
    expect(budgets.kbMinRelevance).toBeCloseTo(0.4);
  });

  it('two-way drift guard: the resolver falls back to each setting-schema default, not a hand-copied literal', async () => {
    // settings.test.ts pins the schema side (defaultValue === the same imported constant); this
    // pins the RESOLVER side against the setting's declared defaultValue directly, so the two
    // cannot silently diverge even if one side's import is later swapped for a literal.
    const { settingsMap } = await import('@bike4mind/common');
    const budgets = await resolveSearchBudgets(makeDb({}));
    expect(budgets.kbDefaultResults).toBe(settingsMap.kbSearchDefaultResults.defaultValue);
    expect(budgets.kbResultTokenBudget).toBe(settingsMap.kbSearchResultTokenBudget.defaultValue);
    expect(budgets.kbMinRelevance).toBe((settingsMap.kbSearchMinRelevancePct.defaultValue as number) / 100);
  });
});

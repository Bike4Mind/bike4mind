import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  MIN_PASSAGE_TOKEN_TARGET,
  SERVE_CHUNK_CHARS_CEILING,
  SERVE_CHUNK_CHARS_FLOOR,
  deriveServeCharBudget,
} from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { resolveSearchBudgets } from './resolveSearchBudgets';

/**
 * The resolver reads through the CACHED settings accessor, so every case builds its own repository
 * stub and passes skipCache-free calls: findBySettingNames is what getSettingsByNames consults, and
 * findAll is only reached on the cache-population path.
 */
function settingsStub(rows: Record<string, string | null>) {
  return {
    adminSettings: {
      findBySettingNames: vi.fn(async (names: string[]) =>
        names.filter(name => name in rows).map(name => ({ settingName: name, settingValue: rows[name] }))
      ),
      findAll: vi.fn(async () =>
        Object.entries(rows).map(([settingName, settingValue]) => ({ settingName, settingValue }))
      ),
    },
  } as unknown as Parameters<typeof resolveSearchBudgets>[0];
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

describe('resolveSearchBudgets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The settings cache is a module-level global keyed 'all_settings', so without this a later case
    // reads the previous case's stored values and passes or fails for the wrong reason.
    invalidateSettingsCache();
  });

  it('derives the serve budget from the chunk policy, not from a cap of its own', async () => {
    const logger = loggerStub();

    const budgets = await resolveSearchBudgets(settingsStub({ DefaultChunkSize: '1000' }), logger);

    expect(budgets.maxChunkChars).toBe(deriveServeCharBudget(1000).maxChunkChars);
    // The invariant the issue asks for: a full chunk fits in what the serve path will emit.
    expect(budgets.maxChunkChars).toBeGreaterThan(SERVE_CHUNK_CHARS_FLOOR);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to the chunker default when no chunk size is configured, silently', async () => {
    const logger = loggerStub();

    const budgets = await resolveSearchBudgets(settingsStub({}), logger);

    expect(budgets.maxChunkChars).toBe(deriveServeCharBudget(DEFAULT_PASSAGE_TOKEN_TARGET).maxChunkChars);
    // An unset setting is the normal case, so it must not look like a misconfiguration.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and uses the chunker default for a set-but-unusable chunk size', async () => {
    const logger = loggerStub();

    const budgets = await resolveSearchBudgets(settingsStub({ DefaultChunkSize: 'not-a-number' }), logger);

    expect(budgets.maxChunkChars).toBe(deriveServeCharBudget(DEFAULT_PASSAGE_TOKEN_TARGET).maxChunkChars);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DefaultChunkSize'));
  });

  it('never serves below the historical cap, however small the configured chunk is', async () => {
    const budgets = await resolveSearchBudgets(settingsStub({ DefaultChunkSize: String(MIN_PASSAGE_TOKEN_TARGET) }));

    expect(budgets.maxChunkChars).toBe(SERVE_CHUNK_CHARS_FLOOR);
  });

  it('warns that clipping is expected when the ceiling leaves the cap below the chunk size', async () => {
    const logger = loggerStub();

    // 6554 tokens is what the pre-passage-granularity chunker produced; those chunks still exist.
    const budgets = await resolveSearchBudgets(settingsStub({ DefaultChunkSize: '6554' }), logger);

    expect(budgets.maxChunkChars).toBe(SERVE_CHUNK_CHARS_CEILING);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('6554'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('clipped'));
  });

  it('still resolves the scan budgets alongside the serve budget', async () => {
    const budgets = await resolveSearchBudgets(
      settingsStub({ dataLakeSearchMaxFiles: '10', dataLakeSearchMaxChunks: '250', DefaultChunkSize: '512' })
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

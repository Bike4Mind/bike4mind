import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Logger } from '@bike4mind/observability';

// Mock the scoped-settings resolver so this suite tests THIS module's wiring (origin gating,
// which read path runs, degrade-on-error) rather than re-testing the resolver, which owns its own
// suite. scopeForLake is a passthrough stub so we can assert it receives the loaded lake.
vi.mock('@bike4mind/services', () => ({
  scopedSettingsService: {
    resolveScopedSetting: vi.fn(),
    scopeForLake: vi.fn((lake: { id?: string }) => ({ lakeId: lake.id })),
  },
}));

import { scopedSettingsService } from '@bike4mind/services';
import { isConvergenceHalted } from './convergenceKillSwitch';
import { provenancePayloadShape, shouldHaltConvergence, CONVERGENCE_ORIGIN } from './convergenceProvenance';

const resolveScopedSetting = vi.mocked(scopedSettingsService.resolveScopedSetting);
const scopeForLake = vi.mocked(scopedSettingsService.scopeForLake);

describe('shouldHaltConvergence (the load-bearing invariant)', () => {
  it('never halts user work, even when paused', () => {
    expect(shouldHaltConvergence('user', true)).toBe(false);
    expect(shouldHaltConvergence('user', false)).toBe(false);
  });

  it('halts convergence work only when paused', () => {
    expect(shouldHaltConvergence('convergence', true)).toBe(true);
    expect(shouldHaltConvergence('convergence', false)).toBe(false);
  });
});

describe('provenancePayloadShape (fail-soft to user)', () => {
  const schema = z.object(provenancePayloadShape);

  it('defaults a missing origin to undefined (handled as user work)', () => {
    expect(schema.parse({}).origin).toBeUndefined();
  });

  it('preserves a valid origin and lakeId', () => {
    expect(schema.parse({ origin: 'convergence', lakeId: LAKE_OID })).toEqual({
      origin: 'convergence',
      lakeId: LAKE_OID,
    });
  });

  it('drops a malformed origin to undefined rather than throwing (a poison message must not halt user work)', () => {
    expect(schema.parse({ origin: 'garbage' }).origin).toBeUndefined();
  });
});

/**
 * A real 24-char hex id. The per-lake arm only runs for an id that can address a row - a static
 * registry lake's id is a human slug, and passing one to findById is what used to CastError and fail
 * the whole switch open (see the guard in resolvePauseFlag).
 */
const LAKE_OID = '0123456789abcdef01234567';

describe('isConvergenceHalted', () => {
  const makeDeps = () => ({
    adminSettings: {
      getSettingsValue: vi.fn(),
      findBySettingNames: vi.fn(),
      findAll: vi.fn(),
    },
    scopedSettings: { findOverrides: vi.fn() },
    dataLakes: { findById: vi.fn() },
  });

  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
  });

  it('short-circuits user work with no settings read', async () => {
    expect(await isConvergenceHalted({ origin: 'user' }, deps)).toBe(false);
    expect(deps.adminSettings.getSettingsValue).not.toHaveBeenCalled();
    expect(deps.dataLakes.findById).not.toHaveBeenCalled();
  });

  it('treats a missing origin as user work (never halted)', async () => {
    deps.adminSettings.getSettingsValue.mockResolvedValue(true);
    expect(await isConvergenceHalted({}, deps)).toBe(false);
    expect(deps.adminSettings.getSettingsValue).not.toHaveBeenCalled();
  });

  it('halts global convergence work when the platform switch is on', async () => {
    deps.adminSettings.getSettingsValue.mockResolvedValue(true);
    expect(await isConvergenceHalted({ origin: 'convergence' }, deps)).toBe(true);
    expect(deps.dataLakes.findById).not.toHaveBeenCalled();
  });

  it('lets global convergence work run when the platform switch is off', async () => {
    deps.adminSettings.getSettingsValue.mockResolvedValue(false);
    expect(await isConvergenceHalted({ origin: 'convergence' }, deps)).toBe(false);
  });

  it('halts per-lake convergence work when the lake override resolves to paused', async () => {
    deps.dataLakes.findById.mockResolvedValue({ id: LAKE_OID, createdByUserId: 'u1' });
    resolveScopedSetting.mockResolvedValue({ value: true, source: 'Lake' } as never);

    expect(await isConvergenceHalted({ origin: 'convergence', lakeId: LAKE_OID }, deps)).toBe(true);
    expect(scopeForLake).toHaveBeenCalledWith({ id: LAKE_OID, createdByUserId: 'u1' });
    expect(resolveScopedSetting).toHaveBeenCalledWith(
      'PauseLakeConvergence',
      { lakeId: LAKE_OID },
      expect.objectContaining({ adminSettings: deps.adminSettings, scopedSettings: deps.scopedSettings }),
      expect.anything()
    );
    // The scoped resolver folds in the platform base, so no separate platform read is needed.
    expect(deps.adminSettings.getSettingsValue).not.toHaveBeenCalled();
  });

  it('lets per-lake convergence work run when the lake override resolves to not-paused', async () => {
    deps.dataLakes.findById.mockResolvedValue({ id: LAKE_OID, createdByUserId: 'u1' });
    resolveScopedSetting.mockResolvedValue({ value: false, source: 'Platform' } as never);
    expect(await isConvergenceHalted({ origin: 'convergence', lakeId: LAKE_OID }, deps)).toBe(false);
  });

  it('reads the PLATFORM switch for a static registry lake, whose id is a slug not an ObjectId', async () => {
    // The whole switch used to fail open here: BaseModel.findById passes the slug straight to
    // Mongoose, the CastError lands in resolvePauseFlag's catch, and it returns false WITHOUT ever
    // reading the platform value - so a paused platform did not halt the one lake class the
    // "Rebuild passages" door is deliberately kept open for.
    deps.adminSettings.getSettingsValue.mockResolvedValue(true);

    expect(await isConvergenceHalted({ origin: 'convergence', lakeId: 'opti-knowledge' }, deps)).toBe(true);

    // No lookup attempted at all - a lake with no document has nowhere to carry a scoped override.
    expect(deps.dataLakes.findById).not.toHaveBeenCalled();
    expect(resolveScopedSetting).not.toHaveBeenCalled();
    expect(deps.adminSettings.getSettingsValue).toHaveBeenCalledWith('PauseLakeConvergence');
  });

  it('lets a static registry lake run when the platform switch is off', async () => {
    deps.adminSettings.getSettingsValue.mockResolvedValue(false);
    expect(await isConvergenceHalted({ origin: 'convergence', lakeId: 'opti-knowledge' }, deps)).toBe(false);
  });

  it('falls back to the platform switch when the lake was deleted between enqueue and handling', async () => {
    deps.dataLakes.findById.mockResolvedValue(null);
    deps.adminSettings.getSettingsValue.mockResolvedValue(true);
    expect(await isConvergenceHalted({ origin: 'convergence', lakeId: LAKE_OID }, deps)).toBe(true);
    expect(resolveScopedSetting).not.toHaveBeenCalled();
  });

  it('degrades to not-paused and warns when the read fails (a failed read is not a "halt")', async () => {
    deps.adminSettings.getSettingsValue.mockRejectedValue(new Error('mongo down'));
    const logger = { warn: vi.fn() } as unknown as Logger;
    expect(await isConvergenceHalted({ origin: 'convergence' }, deps, logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('CONVERGENCE_ORIGIN', () => {
  it('is the value producers stamp to mark haltable background work', () => {
    expect(CONVERGENCE_ORIGIN).toBe('convergence');
    expect(shouldHaltConvergence(CONVERGENCE_ORIGIN, true)).toBe(true);
  });
});

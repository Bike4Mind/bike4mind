import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ convert: vi.fn(), storage: { tag: 'files' } }));

vi.mock('../legacyQuestPlanArchiveStorage', () => ({ filesArchiveStorage: () => h.storage }));
vi.mock('../legacyQuestPlanConversion', () => ({
  DEFAULT_RUN_MS: 12 * 60 * 1000,
  convertLegacyQuestPlans: h.convert,
}));

import migration from './20260921241025_refresh-legacy-quest-plan-files';

const converted = (over: { planFailed?: number; graphFailed?: number; stoppedEarly?: boolean } = {}) => ({
  plans: { failed: over.planFailed ?? 0 },
  graphs: { failed: over.graphFailed ?? 0 },
  stoppedEarly: over.stoppedEarly ?? false,
});

describe('refresh-legacy-quest-plan-files migration', () => {
  beforeEach(() => {
    h.convert.mockReset().mockResolvedValue(converted());
  });

  it('re-runs the shared conversion into files and completes', async () => {
    await expect(migration.up()).resolves.toBeUndefined();
    expect(h.convert).toHaveBeenCalledTimes(1);
    expect(h.convert.mock.calls[0][0].storage).toBe(h.storage);
  });

  it('stays pending when the conversion ran out of time', async () => {
    h.convert.mockResolvedValue(converted({ stoppedEarly: true }));
    await expect(migration.up()).resolves.toEqual({
      incomplete: true,
      reason: 'ran out of time before visiting every source',
    });
  });

  it('stays pending when a source failed to convert', async () => {
    h.convert.mockResolvedValue(converted({ planFailed: 1, graphFailed: 2 }));
    await expect(migration.up()).resolves.toEqual({ incomplete: true, reason: '3 source(s) failed to convert' });
  });

  it('budgets against the migrator run start', async () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    await migration.up({ startedAt });
    expect(h.convert.mock.calls[0][0].deadline).toEqual(new Date(startedAt.getTime() + 12 * 60 * 1000));
  });

  it('sorts after the first conversion and below the fail-closed backfill', () => {
    expect(migration.id).toBeGreaterThan(20260921239990);
    expect(migration.id).toBeLessThan(20260922000001);
  });
});

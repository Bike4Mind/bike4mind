import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ convert: vi.fn(), verify: vi.fn(), storage: { tag: 'files' } }));

vi.mock('../legacyQuestPlanArchiveStorage', () => ({ filesArchiveStorage: () => h.storage }));
vi.mock('../legacyQuestPlanConversion', () => ({
  DEFAULT_RUN_MS: 12 * 60 * 1000,
  convertLegacyQuestPlans: h.convert,
  verifyLegacyQuestPlanCoverage: h.verify,
}));

import migration from './20260921241030_verify-legacy-quest-plan-files';

const converted = (over: { planFailed?: number; graphFailed?: number; stoppedEarly?: boolean } = {}) => ({
  plans: { failed: over.planFailed ?? 0 },
  graphs: { failed: over.graphFailed ?? 0 },
  stoppedEarly: over.stoppedEarly ?? false,
});

const coverage = (expected: number, files: number, over: Record<string, unknown> = {}) => ({
  expected,
  files,
  missing: 0,
  stale: 0,
  uncoveredSamples: [],
  ...over,
});

describe('verify-legacy-quest-plan-files migration', () => {
  beforeEach(() => {
    h.convert.mockReset().mockResolvedValue(converted());
    h.verify.mockReset().mockResolvedValue({
      plans: coverage(3, 3),
      graphs: coverage(2, 2),
      stoppedEarly: false,
      covered: true,
    });
  });

  it('re-runs the shared conversion before verifying', async () => {
    await migration.up();
    expect(h.convert).toHaveBeenCalledTimes(1);
    expect(h.convert.mock.calls[0][0].storage).toBe(h.storage);
    expect(h.convert.mock.invocationCallOrder[0]).toBeLessThan(h.verify.mock.invocationCallOrder[0]);
  });

  it('completes and reports matching plan, graph and file counts', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(migration.up()).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith('Legacy quest plan coverage: plans=3 planFiles=3 graphs=2 graphFiles=2');
    info.mockRestore();
  });

  it('fails the run when a plan has no matching file', async () => {
    h.verify.mockResolvedValue({
      plans: coverage(3, 2, { missing: 1, uncoveredSamples: ['plan-a'] }),
      graphs: coverage(2, 2),
      stoppedEarly: false,
      covered: false,
    });
    await expect(migration.up()).rejects.toThrow(
      'Legacy quest plan coverage check failed. plans: 1 missing, 0 stale (sample: plan-a); graphs: 0 missing, 0 stale'
    );
  });

  it('fails the run when a graph file is stale', async () => {
    h.verify.mockResolvedValue({
      plans: coverage(3, 3),
      graphs: coverage(2, 1, { stale: 1, uncoveredSamples: ['graph-a'] }),
      stoppedEarly: false,
      covered: false,
    });
    await expect(migration.up()).rejects.toThrow('graphs: 0 missing, 1 stale (sample: graph-a)');
  });

  it('stays pending without verifying when the conversion ran out of time', async () => {
    h.convert.mockResolvedValue(converted({ stoppedEarly: true }));
    await expect(migration.up()).resolves.toEqual({
      incomplete: true,
      reason: 'ran out of time before visiting every source',
    });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('stays pending without verifying when a source failed to convert', async () => {
    h.convert.mockResolvedValue(converted({ planFailed: 1, graphFailed: 2 }));
    await expect(migration.up()).resolves.toEqual({ incomplete: true, reason: '3 source(s) failed to convert' });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('stays pending when the check ran out of time, even if nothing was uncovered so far', async () => {
    h.verify.mockResolvedValue({ plans: coverage(1, 1), graphs: coverage(0, 0), stoppedEarly: true, covered: false });
    await expect(migration.up()).resolves.toEqual({
      incomplete: true,
      reason: 'ran out of time before verifying every source',
    });
  });

  it('budgets both steps against the migrator run start', async () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    await migration.up({ startedAt });
    const expected = new Date(startedAt.getTime() + 12 * 60 * 1000);
    expect(h.convert.mock.calls[0][0].deadline).toEqual(expected);
    expect(h.verify.mock.calls[0][0].deadline).toEqual(expected);
  });

  it('sorts below the fail-closed backfill that must stay the highest id', () => {
    expect(migration.id).toBeLessThan(20260922000001);
    expect(migration.id).toBeGreaterThan(20260921239990);
  });
});

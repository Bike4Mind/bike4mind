import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ verify: vi.fn(), refreshApplied: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ Migration: { exists: h.refreshApplied } }));
vi.mock('./20260921241025_refresh-legacy-quest-plan-files', () => ({ default: { id: 20260921241025 } }));
vi.mock('../legacyQuestPlanConversion', () => ({
  DEFAULT_RUN_MS: 12 * 60 * 1000,
  verifyLegacyQuestPlanCoverage: h.verify,
}));

import migration from './20260921241030_verify-legacy-quest-plan-files';

const coverage = (expected: number, files: number, over: Record<string, unknown> = {}) => ({
  expected,
  files,
  skippedNoOwner: 0,
  missing: 0,
  stale: 0,
  uncoveredSamples: [],
  ...over,
});

describe('verify-legacy-quest-plan-files migration', () => {
  beforeEach(() => {
    h.refreshApplied.mockReset().mockResolvedValue({ _id: 'applied' });
    h.verify.mockReset().mockResolvedValue({
      plans: coverage(3, 3),
      graphs: coverage(2, 2),
      stoppedEarly: false,
      covered: true,
    });
  });

  it('stays pending without verifying until the refresh migration is applied', async () => {
    h.refreshApplied.mockResolvedValue(null);
    await expect(migration.up()).resolves.toEqual({
      incomplete: true,
      reason: 'waiting for the legacy quest plan refresh to finish',
    });
    expect(h.refreshApplied).toHaveBeenCalledWith({ id: 20260921241025 });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('completes and reports matching plan, graph and file counts', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(migration.up()).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(
      'Legacy quest plan coverage: plans=3 planFiles=3 graphs=2 graphFiles=2 plansWithoutOwner=0 graphsWithoutOwner=0'
    );
    info.mockRestore();
  });

  it('reports sources that have no live owner', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    h.verify.mockResolvedValue({
      plans: coverage(3, 3, { skippedNoOwner: 4 }),
      graphs: coverage(2, 2, { skippedNoOwner: 1 }),
      stoppedEarly: false,
      covered: true,
    });
    await migration.up();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('plansWithoutOwner=4 graphsWithoutOwner=1'));
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

  it('stays pending when the check ran out of time, even if nothing was uncovered so far', async () => {
    h.verify.mockResolvedValue({ plans: coverage(1, 1), graphs: coverage(0, 0), stoppedEarly: true, covered: false });
    await expect(migration.up()).resolves.toEqual({
      incomplete: true,
      reason: 'ran out of time before verifying every source',
    });
  });

  it('budgets the check against the migrator run start', async () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    await migration.up({ startedAt });
    expect(h.verify.mock.calls[0][0].deadline).toEqual(new Date(startedAt.getTime() + 12 * 60 * 1000));
  });

  it('sorts after the refresh and below the fail-closed backfill that must stay the highest id', () => {
    expect(migration.id).toBeLessThan(20260922000001);
    expect(migration.id).toBeGreaterThan(20260921241025);
  });
});

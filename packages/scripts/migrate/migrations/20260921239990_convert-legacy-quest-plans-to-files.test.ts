import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ convert: vi.fn() }));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: () => ({}) }));
vi.mock('../legacyQuestPlanConversion', () => ({ DEFAULT_RUN_MS: 12 * 60 * 1000, convertLegacyQuestPlans: h.convert }));

import migration from './20260921239990_convert-legacy-quest-plans-to-files';

const counts = (failed = 0) => ({ failed });

describe('convert-legacy-quest-plans-to-files migration', () => {
  beforeEach(() => h.convert.mockReset());

  it('completes when every source was visited without a failure', async () => {
    h.convert.mockResolvedValue({ plans: counts(), graphs: counts(), stoppedEarly: false });
    await expect(migration.up()).resolves.toBeUndefined();
  });

  it('stays pending when the pass ran out of time', async () => {
    h.convert.mockResolvedValue({ plans: counts(), graphs: counts(), stoppedEarly: true });
    await expect(migration.up()).resolves.toMatchObject({ incomplete: true });
  });

  it('stays pending when any source failed, so the next run retries it', async () => {
    h.convert.mockResolvedValue({ plans: counts(0), graphs: counts(2), stoppedEarly: false });
    await expect(migration.up()).resolves.toEqual({ incomplete: true, reason: '2 source(s) failed to convert' });
  });

  it('budgets against the migrator run start, not its own start', async () => {
    h.convert.mockResolvedValue({ plans: counts(), graphs: counts(), stoppedEarly: false });
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    await migration.up({ startedAt });
    const [{ deadline }] = h.convert.mock.calls[0];
    expect(deadline).toEqual(new Date(startedAt.getTime() + 12 * 60 * 1000));
  });
});

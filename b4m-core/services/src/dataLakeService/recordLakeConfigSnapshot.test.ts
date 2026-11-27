import { describe, it, expect, vi } from 'vitest';
import { LAKE_CONFIG_SNAPSHOT_TTL_DAYS } from '@bike4mind/common';
import { recordLakeConfigSnapshot } from './recordLakeConfigSnapshot';

const NOW = new Date('2026-03-01T00:00:00Z');
const snapshot = { dataLakeId: 'lake1', kind: 'feed-url-edited' as const, feedUrlBefore: 'a', feedUrlAfter: 'b' };

describe('recordLakeConfigSnapshot', () => {
  it('keys the snapshot to the event and stamps the 30-day expiry', async () => {
    const record = vi.fn().mockResolvedValue({});
    await recordLakeConfigSnapshot('evt1', snapshot, { db: { lakeConfigSnapshots: { record } } }, NOW);
    expect(record).toHaveBeenCalledWith({
      ...snapshot,
      eventId: 'evt1',
      expiresAt: new Date(NOW.getTime() + LAKE_CONFIG_SNAPSHOT_TTL_DAYS * 86_400_000),
    });
  });

  it('writes nothing when the History row was not written', async () => {
    const record = vi.fn();
    await recordLakeConfigSnapshot(null, snapshot, { db: { lakeConfigSnapshots: { record } } }, NOW);
    expect(record).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed write', async () => {
    const record = vi.fn().mockRejectedValue(new Error('down'));
    const warn = vi.fn();
    await expect(
      recordLakeConfigSnapshot(
        'evt1',
        snapshot,
        { db: { lakeConfigSnapshots: { record } }, logger: { warn } as never },
        NOW
      )
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('snapshot did not persist'), expect.anything());
  });
});

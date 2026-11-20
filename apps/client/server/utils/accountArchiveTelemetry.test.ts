import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ find: vi.fn(), hashes: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ Quest: { find: mocks.find } }));
vi.mock('./telemetryHashLookup', () => ({ regenerateUserTelemetryHashes: mocks.hashes }));

import { collectAccountTelemetry } from './accountArchiveTelemetry';
import { TELEMETRY_EXPORT_PROJECTION } from './telemetryProjection';

describe('account archive telemetry adapter', () => {
  it('matches only regenerated owner hashes using the DSAR-safe projection', async () => {
    mocks.hashes.mockResolvedValue(['owner-hash']);
    const select = vi.fn(() => ({
      lean: async () => [
        { timestamp: new Date('2025-01-01'), promptMeta: { contextTelemetry: { action: 'view' } } },
        { timestamp: new Date('2025-01-02'), promptMeta: {} },
      ],
    }));
    mocks.find.mockReturnValue({ select });

    await expect(collectAccountTelemetry('owner')).resolves.toEqual([
      { timestamp: '2025-01-01T00:00:00.000Z', telemetry: { action: 'view' } },
    ]);
    expect(mocks.hashes).toHaveBeenCalledWith('owner');
    expect(mocks.find).toHaveBeenCalledWith({
      'promptMeta.contextTelemetry.anonymousSessionId.hash': { $in: ['owner-hash'] },
    });
    expect(select).toHaveBeenCalledWith(TELEMETRY_EXPORT_PROJECTION);
  });
});

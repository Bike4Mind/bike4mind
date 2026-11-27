import { describe, expect, it, vi } from 'vitest';
import type { AccessContext } from '@bike4mind/common';
import { listDataLakes } from './listDataLakes';

const context: AccessContext = { userId: 'member', isAdmin: false, userTags: ['Opti'], organizationIds: [] };
const adapters = () => ({
  db: {
    dataLakes: {
      findIdsCreatedBy: vi.fn(async (): Promise<string[]> => []),
      findAccessible: vi.fn(async () => []),
      find: vi.fn(async () => []),
    },
    dataLakeAccessGrants: {
      listByPrincipal: vi.fn(async () => []),
      listActiveByLakes: vi.fn(async () => []),
    },
    settings: { getSettingsValue: vi.fn(async () => true) },
  },
});

describe('listDataLakes complete access resolution', () => {
  it.each(['dynamic', 'creator', 'supersession', 'settings'] as const)(
    'rejects an unknown %s result for audit while preserving ordinary browse fallback',
    async source => {
      const dependencies = adapters();
      const failure = new Error('Access lookup unavailable');
      if (source === 'dynamic') dependencies.db.dataLakes.findAccessible.mockRejectedValue(failure);
      if (source === 'creator') dependencies.db.dataLakes.findIdsCreatedBy.mockRejectedValue(failure);
      if (source === 'supersession') {
        dependencies.db.dataLakes.findIdsCreatedBy.mockResolvedValue(['owned']);
        dependencies.db.dataLakeAccessGrants.listActiveByLakes.mockRejectedValue(failure);
      }
      if (source === 'settings') dependencies.db.settings.getSettingsValue.mockRejectedValue(failure);
      expect((await listDataLakes(context, dependencies)).map(lake => lake.id)).toContain('opti-knowledge');
      await expect(listDataLakes(context, { ...dependencies, requireCompleteAccess: true })).rejects.toThrow();
    }
  );

  it.each(['settings', 'grants'] as const)(
    'requires the %s adapter before promising complete access',
    async missing => {
      const dependencies = adapters();
      const db =
        missing === 'settings'
          ? { ...dependencies.db, settings: undefined }
          : { ...dependencies.db, dataLakeAccessGrants: undefined };
      await expect(listDataLakes(context, { db })).resolves.toEqual(expect.any(Array));
      await expect(listDataLakes(context, { db, requireCompleteAccess: true })).rejects.toThrow(
        'Complete lake access requires settings and grant adapters'
      );
    }
  );

  it('allows an explicit OFF setting and retries a failed dynamic lookup', async () => {
    const dependencies = adapters();
    dependencies.db.settings.getSettingsValue.mockResolvedValue(false);
    dependencies.db.dataLakes.findAccessible.mockRejectedValueOnce(new Error('Temporary outage'));
    await expect(listDataLakes(context, { ...dependencies, requireCompleteAccess: true })).rejects.toThrow();
    await expect(listDataLakes(context, { ...dependencies, requireCompleteAccess: true })).resolves.toEqual(
      expect.any(Array)
    );
  });
});

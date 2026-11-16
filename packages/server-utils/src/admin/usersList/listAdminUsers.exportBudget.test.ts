import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Organization, User } from '@bike4mind/database';
import type { AdminUsersFilter } from '../../app/utils/adminUsersFilter';

const { cohort } = vi.hoisted(() => ({ cohort: vi.fn<(...args: unknown[]) => Promise<string[]>>() }));
vi.mock('../../analytics/acquisitionConversion', async importOriginal => ({
  ...(await importOriginal<typeof import('../../analytics/acquisitionConversion')>()),
  acquisitionCohortUserIds: cohort,
}));

import { exportAdminUsers } from './listAdminUsers';

const NOW = new Date('2026-11-16T12:00:00Z');
const filter: AdminUsersFilter = {
  createdFrom: '2026-05-01T00:00:00Z',
  createdTo: '2026-06-01T00:00:00Z',
  acqSource: 'ads',
  acqTouch: 'first',
  acqConverted: 'true',
  acqWindow: '30',
};
type ExportRow = { name?: string; organizationId?: string };
const option = vi.fn<(options: { maxTimeMS: number; allowDiskUse: boolean }) => Promise<ExportRow[]>>();
const organizations = vi.fn<() => Promise<{ _id: string; name: string }[]>>();
type OrganizationQuery = {
  select: () => OrganizationQuery;
  lean: typeof organizations;
  maxTimeMS: (value: number) => OrganizationQuery;
};
const organizationMaxTimeMS = vi.fn<(value: number) => OrganizationQuery>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  cohort.mockResolvedValue([]);
  option.mockResolvedValue([]);
  organizations.mockResolvedValue([]);
  vi.spyOn(User, 'aggregate').mockReturnValue({ option } as unknown as ReturnType<typeof User.aggregate>);
  const query: OrganizationQuery = { select: () => query, lean: organizations, maxTimeMS: organizationMaxTimeMS };
  organizationMaxTimeMS.mockReturnValue(query);
  vi.spyOn(Organization, 'find').mockReturnValue(query as unknown as ReturnType<typeof Organization.find>);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the Users export request budget', () => {
  it('limits the terminal read to the budget remaining after cohort resolution', async () => {
    cohort.mockImplementationOnce(async () => {
      vi.setSystemTime(NOW.getTime() + 35_000);
      return [];
    });

    await exportAdminUsers(filter, NOW);

    expect(option).toHaveBeenCalledOnce();
    expect(option.mock.calls[0][0].maxTimeMS).toBeGreaterThan(0);
    expect(option.mock.calls[0][0].maxTimeMS).toBeLessThanOrEqual(15_000);
  });

  it('starts no terminal read when cohort resolution has exhausted the request budget', async () => {
    cohort.mockImplementationOnce(async () => {
      vi.setSystemTime(NOW.getTime() + 51_000);
      return [];
    });

    await expect(exportAdminUsers(filter, NOW)).rejects.toMatchObject({ statusCode: 504 });
    expect(User.aggregate).not.toHaveBeenCalled();
  });

  it('returns a handled timeout before the Lambda deadline when a terminal query never answers', async () => {
    option.mockReturnValueOnce(new Promise<never>(() => undefined));
    const failure = expect(exportAdminUsers(filter, NOW)).rejects.toMatchObject({ statusCode: 504 });

    await vi.advanceTimersByTimeAsync(50_000);
    await failure;
  });

  it('bounds the organization-name lookup by the remaining request time', async () => {
    cohort.mockImplementationOnce(async () => {
      vi.setSystemTime(NOW.getTime() + 35_000);
      return [];
    });
    option.mockImplementationOnce(async () => {
      vi.setSystemTime(NOW.getTime() + 45_000);
      return [{ name: 'Ada', organizationId: 'a'.repeat(24) }];
    });
    organizations.mockResolvedValueOnce([{ _id: 'a'.repeat(24), name: 'Acme' }]);

    const result = await exportAdminUsers(filter, NOW);

    expect(organizationMaxTimeMS).toHaveBeenCalledOnce();
    expect(organizationMaxTimeMS.mock.calls[0][0]).toBeLessThanOrEqual(5_000);
    expect(result.users[0].organizationName).toBe('Acme');
  });
  it('starts no export read when a held cohort resolves after the response deadline', async () => {
    const pending = Promise.withResolvers<string[]>();
    cohort.mockReturnValueOnce(pending.promise);
    const failure = expect(exportAdminUsers(filter, NOW)).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(50_000);
    await failure;

    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(User.aggregate).not.toHaveBeenCalled();
  });

  it('starts no organization lookup when a held user read resolves after the response deadline', async () => {
    const pending = Promise.withResolvers<ExportRow[]>();
    option.mockReturnValueOnce(pending.promise);
    const failure = expect(exportAdminUsers(filter, NOW)).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(50_000);
    await failure;

    pending.resolve([{ name: 'Ada', organizationId: 'a'.repeat(24) }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(Organization.find).not.toHaveBeenCalled();
  });
});

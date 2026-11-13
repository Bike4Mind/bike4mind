import { describe, it, expect, beforeEach } from 'vitest';
import {
  orgAdminNotificationPrefRepository as repo,
  OrgAdminNotificationPrefModel,
} from './OrgAdminNotificationPrefModel';
import { setupMongoTest } from '../../../__test__/utils';

describe('OrgAdminNotificationPrefRepository', () => {
  setupMongoTest();
  beforeEach(async () => {
    await OrgAdminNotificationPrefModel.ensureIndexes();
  });

  it('creates one row per (org, user) and merges later partial updates', async () => {
    await repo.upsertForUser('org-1', 'u1', { low_balance: true });
    await repo.upsertForUser('org-1', 'u1', { low_balance: true });
    const merged = await repo.upsertForUser('org-1', 'u1', { seat_limit: false });

    expect(await OrgAdminNotificationPrefModel.countDocuments({})).toBe(1);
    expect(merged?.kinds).toEqual({ low_balance: true, seat_limit: false });
  });

  it('leaves unset kinds absent so the role default applies', async () => {
    await repo.upsertForUser('org-1', 'u1', { low_balance: false });

    const row = await repo.getForUser('org-1', 'u1');
    expect(row?.kinds.low_balance).toBe(false);
    expect(row?.kinds.budget_threshold).toBeUndefined();
  });

  it('getForOrg returns only that org', async () => {
    await repo.upsertForUser('org-1', 'u1', { low_balance: true });
    await repo.upsertForUser('org-1', 'u2', { low_balance: true });
    await repo.upsertForUser('org-2', 'u1', { low_balance: true });

    expect((await repo.getForOrg('org-1')).map(r => r.userId).sort()).toEqual(['u1', 'u2']);
  });
});

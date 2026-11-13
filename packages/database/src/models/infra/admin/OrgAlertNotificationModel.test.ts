import { describe, it, expect, beforeEach } from 'vitest';
import type { ClaimOrgAlertInput } from '@bike4mind/common';
import { orgAlertNotificationRepository as repo, OrgAlertNotificationModel } from './OrgAlertNotificationModel';
import { setupMongoTest } from '../../../__test__/utils';

const input = (overrides: Partial<ClaimOrgAlertInput> = {}): ClaimOrgAlertInput => ({
  organizationId: 'org-1',
  kind: 'budget_threshold',
  scope: 'pct:80',
  periodKey: '2026-11',
  ...overrides,
});

describe('OrgAlertNotificationRepository', () => {
  setupMongoTest();
  // setupMongoTest drops the database (indexes included) before each test.
  beforeEach(async () => {
    await OrgAlertNotificationModel.ensureIndexes();
  });

  it('claims once per (organizationId, kind, scope, periodKey)', async () => {
    const first = await repo.claim(input());
    const second = await repo.claim(input());

    expect(first.claimed).toBe(true);
    expect(first.id).toBeDefined();
    expect(second).toEqual({ claimed: false });
    const docs = await OrgAlertNotificationModel.find({});
    expect(docs).toHaveLength(1);
    expect(String(docs[0]._id)).toBe(first.id);
    expect(docs[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('lets exactly one of many concurrent claimers win', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.claim(input())));

    expect(results.filter(r => r.claimed)).toHaveLength(1);
    expect(await OrgAlertNotificationModel.countDocuments({})).toBe(1);
  });

  it('treats a new scope or period as a separate slot', async () => {
    await repo.claim(input());

    expect((await repo.claim(input({ scope: 'pct:90' }))).claimed).toBe(true);
    expect((await repo.claim(input({ periodKey: '2026-12' }))).claimed).toBe(true);
    expect((await repo.claim(input({ organizationId: 'org-2' }))).claimed).toBe(true);
  });

  it('release re-opens the slot', async () => {
    const first = await repo.claim(input());
    await repo.release(first.id!);

    expect((await repo.claim(input())).claimed).toBe(true);
  });

  it('records the subject user on a per-person alert', async () => {
    await repo.claim(input({ kind: 'member_cap', scope: 'user:u1', subjectUserId: 'u1' }));

    expect((await OrgAlertNotificationModel.findOne({ kind: 'member_cap' }))?.subjectUserId).toBe('u1');
  });
});

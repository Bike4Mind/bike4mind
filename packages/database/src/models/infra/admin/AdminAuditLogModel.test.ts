import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import type { NewAdminAuditEntry } from '@bike4mind/common';
import { setupMongoTest } from '../../../__test__/utils';
import { adminAuditLogRepository } from './AdminAuditLogModel';
import { AdminAuditReviewModel, adminAuditReviewRepository } from './AdminAuditReviewModel';

const USER_ID = new Types.ObjectId().toHexString();
const ORG_ID = new Types.ObjectId().toHexString();

const entry = (overrides: Partial<NewAdminAuditEntry>, occurredAt: Date): NewAdminAuditEntry => ({
  occurredAt,
  action: 'billing.comp.changed',
  category: 'credits',
  severity: 'notice',
  actor: { kind: 'user', scope: 'platform', userId: 'admin-1', name: 'Admin', wasAdmin: true },
  target: { kind: 'user', id: USER_ID, displayName: 'user@example.com' },
  summary: 'changed a comp',
  context: { source: 'admin_ui' },
  ...overrides,
});

describe('AdminAuditLogRepository.listForSubscription', () => {
  setupMongoTest();

  it('returns a user owner entries that name one of the subscription ids, newest first', async () => {
    await adminAuditLogRepository.append(
      entry({ details: { subscriptionId: 'sub_a' }, summary: 'old' }, new Date('2026-01-01T00:00:00Z'))
    );
    await adminAuditLogRepository.append(
      entry({ details: { subscriptionId: 'sub_a' }, summary: 'new' }, new Date('2026-02-01T00:00:00Z'))
    );
    await adminAuditLogRepository.append(
      entry({ details: { subscriptionId: 'sub_b' } }, new Date('2026-03-01T00:00:00Z'))
    );
    await adminAuditLogRepository.append(
      entry(
        { details: { subscriptionId: 'sub_a' }, target: { kind: 'user', id: 'someone-else', displayName: 'x' } },
        new Date('2026-04-01T00:00:00Z')
      )
    );

    const page = await adminAuditLogRepository.listForSubscription(
      { owner: { kind: 'user', id: USER_ID }, subscriptionIds: ['sub_a'] },
      { limit: 10 }
    );

    expect(page.entries.map(item => item.summary)).toEqual(['new', 'old']);
    expect(page.nextCursor).toBeNull();
  });

  it('matches an organization owner through organizationId or an organization target, by Stripe or Mongo id', async () => {
    const mongoId = new Types.ObjectId().toHexString();
    await adminAuditLogRepository.append(
      entry(
        { organizationId: ORG_ID, details: { subscriptionId: 'sub_org' }, summary: 'by org id' },
        new Date('2026-01-01T00:00:00Z')
      )
    );
    await adminAuditLogRepository.append(
      entry(
        {
          target: { kind: 'organization', id: ORG_ID, displayName: 'Acme' },
          details: { subscriptionId: mongoId },
          summary: 'by target',
        },
        new Date('2026-02-01T00:00:00Z')
      )
    );

    const page = await adminAuditLogRepository.listForSubscription(
      { owner: { kind: 'organization', id: ORG_ID }, subscriptionIds: ['sub_org', mongoId] },
      { limit: 10 }
    );

    expect(page.entries.map(item => item.summary)).toEqual(['by target', 'by org id']);
  });

  it('pages with a cursor', async () => {
    for (let day = 1; day <= 3; day += 1) {
      await adminAuditLogRepository.append(
        entry({ details: { subscriptionId: 'sub_a' }, summary: `day ${day}` }, new Date(`2026-01-0${day}T00:00:00Z`))
      );
    }
    const scope = { owner: { kind: 'user' as const, id: USER_ID }, subscriptionIds: ['sub_a'] };

    const first = await adminAuditLogRepository.listForSubscription(scope, { limit: 2 });
    expect(first.entries.map(item => item.summary)).toEqual(['day 3', 'day 2']);
    expect(first.nextCursor).not.toBeNull();

    const second = await adminAuditLogRepository.listForSubscription(scope, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.entries.map(item => item.summary)).toEqual(['day 1']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('AdminAuditLogRepository.listReviewQueue', () => {
  setupMongoTest();

  const VIEWER = 'viewer-1';
  const critical = (overrides: Partial<NewAdminAuditEntry>, occurredAt: Date) =>
    entry({ severity: 'critical', ...overrides }, occurredAt);
  const byOther = {
    actor: { kind: 'user', scope: 'platform', userId: 'admin-2', name: 'Other', wasAdmin: true },
  } as const;
  const byViewer = {
    actor: { kind: 'user', scope: 'platform', userId: VIEWER, name: 'Viewer', wasAdmin: true },
  } as const;

  it('unreviewed excludes reviewed, own and non-critical entries and includes old ones', async () => {
    await AdminAuditReviewModel.createIndexes();
    const old = await adminAuditLogRepository.append(
      critical({ ...byOther, summary: 'old' }, new Date('2020-01-01T00:00:00Z'))
    );
    const recent = await adminAuditLogRepository.append(
      critical({ ...byOther, summary: 'recent' }, new Date('2026-03-01T00:00:00Z'))
    );
    const reviewed = await adminAuditLogRepository.append(
      critical({ ...byOther, summary: 'reviewed' }, new Date('2026-03-02T00:00:00Z'))
    );
    await adminAuditLogRepository.append(critical({ ...byViewer, summary: 'own' }, new Date('2026-03-03T00:00:00Z')));
    await adminAuditLogRepository.append(
      entry({ ...byOther, severity: 'notice', summary: 'notice' }, new Date('2026-03-04T00:00:00Z'))
    );
    await adminAuditLogRepository.append(
      critical(
        { actor: { kind: 'system', scope: 'platform', name: 'System', wasAdmin: false }, summary: 'system' },
        new Date('2026-03-05T00:00:00Z')
      )
    );
    await adminAuditReviewRepository.createMany([
      { auditEntryId: reviewed.id, reviewer: { userId: VIEWER, name: 'Viewer' } },
    ]);

    const page = await adminAuditLogRepository.listReviewQueue(
      { status: 'unreviewed', viewerUserId: VIEWER },
      { limit: 10 }
    );

    expect(page.entries.map(item => item.summary)).toEqual(['system', 'recent', 'old']);
    expect(page.entries.every(item => item.review === null)).toBe(true);
    expect(page.total).toBe(3);
    expect([old.id, recent.id]).toEqual(expect.arrayContaining([page.entries[1]?.id, page.entries[2]?.id]));
  });

  it('unreviewed leaves out entries about the viewer account but all keeps them', async () => {
    await AdminAuditReviewModel.createIndexes();
    const aboutViewer = await adminAuditLogRepository.append(
      critical(
        {
          ...byOther,
          summary: 'about viewer',
          target: { kind: 'user', id: VIEWER, displayName: 'viewer@example.com' },
        },
        new Date('2026-03-01T00:00:00Z')
      )
    );
    await adminAuditLogRepository.append(
      critical(
        { ...byOther, summary: 'about someone', target: { kind: 'user', id: USER_ID, displayName: 'x@example.com' } },
        new Date('2026-03-02T00:00:00Z')
      )
    );
    await adminAuditLogRepository.append(
      critical(
        { ...byOther, summary: 'org same id', target: { kind: 'organization', id: VIEWER, displayName: 'Org' } },
        new Date('2026-03-03T00:00:00Z')
      )
    );

    const unreviewed = await adminAuditLogRepository.listReviewQueue(
      { status: 'unreviewed', viewerUserId: VIEWER },
      { limit: 10 }
    );
    expect(unreviewed.entries.map(item => item.summary)).toEqual(['org same id', 'about someone']);
    expect(unreviewed.total).toBe(2);

    const all = await adminAuditLogRepository.listReviewQueue(
      { status: 'all', from: new Date('2026-01-01T00:00:00Z'), viewerUserId: VIEWER },
      { limit: 10 }
    );
    expect(all.entries.map(item => item.id)).toContain(aboutViewer.id);
    expect(all.total).toBe(3);
  });

  it('counts only eligible unreviewed critical entries up to the limit', async () => {
    const query = { viewerUserId: VIEWER };
    await expect(adminAuditLogRepository.countUnreviewed(query, { limit: 2 })).resolves.toBe(0);

    const occurredAt = new Date('2026-03-01T00:00:00Z');
    const reviewed = await adminAuditLogRepository.append(critical(byOther, occurredAt));
    await adminAuditReviewRepository.createMany([
      { auditEntryId: reviewed.id, reviewer: { userId: 'someone', name: 'Someone' }, note: 'ok' },
    ]);
    await adminAuditLogRepository.append(critical(byViewer, occurredAt));
    await adminAuditLogRepository.append(
      critical({ ...byOther, target: { kind: 'user', id: VIEWER, displayName: 'Viewer' } }, occurredAt)
    );
    await adminAuditLogRepository.append(entry(byOther, occurredAt));
    for (let i = 0; i < 3; i += 1) {
      await adminAuditLogRepository.append(critical(byOther, occurredAt));
    }

    await expect(adminAuditLogRepository.countUnreviewed(query, { limit: 2 })).resolves.toBe(2);
    await expect(adminAuditLogRepository.countUnreviewed(query, { limit: 10 })).resolves.toBe(3);
  });

  it('pages with a cursor and keeps total independent of it', async () => {
    for (let day = 1; day <= 5; day += 1) {
      await adminAuditLogRepository.append(
        critical({ ...byOther, summary: `entry ${day}` }, new Date(`2026-03-0${day}T00:00:00Z`))
      );
    }

    const first = await adminAuditLogRepository.listReviewQueue(
      { status: 'unreviewed', viewerUserId: VIEWER },
      { limit: 2 }
    );
    expect(first.entries.map(item => item.summary)).toEqual(['entry 5', 'entry 4']);
    expect(first.nextCursor).not.toBeNull();
    expect(first.total).toBe(5);

    const second = await adminAuditLogRepository.listReviewQueue(
      { status: 'unreviewed', viewerUserId: VIEWER },
      { limit: 2, cursor: first.nextCursor ?? undefined }
    );
    expect(second.entries.map(item => item.summary)).toEqual(['entry 3', 'entry 2']);
    expect(second.total).toBe(5);

    const last = await adminAuditLogRepository.listReviewQueue(
      { status: 'unreviewed', viewerUserId: VIEWER },
      { limit: 2, cursor: second.nextCursor ?? undefined }
    );
    expect(last.entries.map(item => item.summary)).toEqual(['entry 1']);
    expect(last.nextCursor).toBeNull();
  });

  it('all respects from, includes the viewer own entries and attaches the review', async () => {
    await adminAuditLogRepository.append(
      critical({ ...byOther, summary: 'too old' }, new Date('2026-01-01T00:00:00Z'))
    );
    const own = await adminAuditLogRepository.append(
      critical({ ...byViewer, summary: 'own' }, new Date('2026-03-01T00:00:00Z'))
    );
    const reviewed = await adminAuditLogRepository.append(
      critical({ ...byOther, summary: 'reviewed' }, new Date('2026-03-02T00:00:00Z'))
    );
    await adminAuditLogRepository.append(
      entry({ ...byOther, severity: 'info', summary: 'info' }, new Date('2026-03-03T00:00:00Z'))
    );
    await adminAuditReviewRepository.createMany([
      { auditEntryId: reviewed.id, reviewer: { userId: 'someone', name: 'Someone' }, note: 'ok' },
    ]);

    const page = await adminAuditLogRepository.listReviewQueue(
      { status: 'all', from: new Date('2026-02-01T00:00:00Z'), viewerUserId: VIEWER },
      { limit: 10 }
    );

    expect(page.entries.map(item => item.summary)).toEqual(['reviewed', 'own']);
    expect(page.entries[0]?.review).toMatchObject({
      auditEntryId: reviewed.id,
      reviewer: { name: 'Someone' },
      note: 'ok',
    });
    expect(page.entries[1]?.id).toBe(own.id);
    expect(page.entries[1]?.review).toBeNull();
    expect(page.total).toBe(2);
  });

  it('unreviewed only scans back to the rollout baseline cutoff, with a day of slack', async () => {
    await AdminAuditReviewModel.createIndexes();
    const day = 24 * 60 * 60 * 1000;
    const baselined = await adminAuditLogRepository.append(
      critical({ ...byOther, summary: 'baselined' }, new Date('2020-01-01T00:00:00Z'))
    );
    await adminAuditReviewRepository.createMany([
      { auditEntryId: baselined.id, reviewer: { userId: null, name: 'Baseline' }, baseline: true },
    ]);
    await adminAuditLogRepository.append(
      critical({ ...byOther, summary: 'before floor' }, new Date(Date.now() - 9 * day))
    );
    await adminAuditLogRepository.append(
      critical({ ...byOther, summary: 'in slack' }, new Date(Date.now() - 7.5 * day))
    );
    await adminAuditLogRepository.append(critical({ ...byOther, summary: 'recent' }, new Date(Date.now() - day)));

    const page = await adminAuditLogRepository.listReviewQueue(
      { status: 'unreviewed', viewerUserId: VIEWER },
      { limit: 10 }
    );

    expect(page.entries.map(item => item.summary)).toEqual(['recent', 'in slack']);
    expect(page.total).toBe(2);
  });

  it('rejects status all without from', async () => {
    await expect(
      adminAuditLogRepository.listReviewQueue({ status: 'all', viewerUserId: VIEWER }, { limit: 10 })
    ).rejects.toThrow('from is required');
  });
});

describe('AdminAuditLogRepository.findByIds', () => {
  setupMongoTest();

  it('returns the matching entries and ignores unknown and malformed ids', async () => {
    const first = await adminAuditLogRepository.append(entry({ summary: 'first' }, new Date('2026-03-01T00:00:00Z')));
    const second = await adminAuditLogRepository.append(entry({ summary: 'second' }, new Date('2026-03-02T00:00:00Z')));

    const found = await adminAuditLogRepository.findByIds([
      first.id,
      second.id,
      new Types.ObjectId().toHexString(),
      'not-an-id',
    ]);

    expect(found.map(item => item.id).sort()).toEqual([first.id, second.id].sort());
    await expect(adminAuditLogRepository.findByIds(['not-an-id'])).resolves.toEqual([]);
  });
});

describe('AdminAuditLogRepository.listForSubscriptionOrOwner', () => {
  setupMongoTest();

  it('returns entries about the owner or naming the subscription, and nothing else', async () => {
    await adminAuditLogRepository.append(
      entry({ details: { subscriptionId: 'sub_b' }, summary: 'owner, other sub' }, new Date('2026-01-01T00:00:00Z'))
    );
    await adminAuditLogRepository.append(
      entry(
        {
          details: { subscriptionId: 'sub_a' },
          target: { kind: 'user', id: 'someone-else', displayName: 'x' },
          summary: 'this sub, other target',
        },
        new Date('2026-02-01T00:00:00Z')
      )
    );
    await adminAuditLogRepository.append(
      entry(
        { details: {}, target: { kind: 'user', id: 'someone-else', displayName: 'x' }, summary: 'unrelated' },
        new Date('2026-03-01T00:00:00Z')
      )
    );

    const page = await adminAuditLogRepository.listForSubscriptionOrOwner(
      { owner: { kind: 'user', id: USER_ID }, subscriptionIds: ['sub_a'] },
      { limit: 10 }
    );

    expect(page.entries.map(item => item.summary)).toEqual(['this sub, other target', 'owner, other sub']);
  });
});

describe('AdminAuditLogRepository.countActions', () => {
  setupMongoTest();

  it('counts one actor entries under the given actions since the cutoff', async () => {
    const since = new Date('2026-03-01T00:00:00Z');
    await adminAuditLogRepository.append(entry({ action: 'user.bulk.suspended' }, new Date('2026-03-02T00:00:00Z')));
    await adminAuditLogRepository.append(entry({ action: 'user.bulk.contained' }, since));
    await adminAuditLogRepository.append(entry({ action: 'user.bulk.suspended' }, new Date('2026-02-28T00:00:00Z')));
    await adminAuditLogRepository.append(entry({ action: 'user.bulk.tagged' }, new Date('2026-03-02T00:00:00Z')));
    await adminAuditLogRepository.append(
      entry(
        {
          action: 'user.bulk.suspended',
          actor: { kind: 'user', scope: 'platform', userId: 'admin-2', name: 'Other', wasAdmin: true },
        },
        new Date('2026-03-02T00:00:00Z')
      )
    );

    await adminAuditLogRepository.append(
      entry(
        { action: 'user.bulk.suspended', details: { approval: { id: 'approval-1' } } },
        new Date('2026-03-02T00:00:00Z')
      )
    );

    await expect(
      adminAuditLogRepository.countActions('admin-1', ['user.bulk.suspended', 'user.bulk.contained'], since)
    ).resolves.toBe(2);
  });
});

describe('AdminAuditLogRepository.sumCreditsGranted excludeApproved', () => {
  setupMongoTest();

  it('includes subscription grants only for approval totals, respecting the actor, window and approval filter', async () => {
    const since = new Date('2026-03-01T00:00:00Z');
    const at = new Date('2026-03-02T00:00:00Z');
    await adminAuditLogRepository.append(entry({ action: 'org.credits.granted', details: { credits: 100 } }, at));
    await adminAuditLogRepository.append(
      entry({ action: 'user.subscription.granted', details: { credits: 600 } }, since)
    );
    await adminAuditLogRepository.append(
      entry({ action: 'user.subscription.granted', details: { credits: 900, approval: { id: 'approval-1' } } }, at)
    );
    await adminAuditLogRepository.append(
      entry({ action: 'user.subscription.granted', details: { credits: 1100 } }, new Date(since.getTime() - 1))
    );
    await adminAuditLogRepository.append(
      entry(
        {
          action: 'user.subscription.granted',
          actor: { kind: 'user', scope: 'platform', userId: 'admin-2', name: 'Other', wasAdmin: true },
          details: { credits: 1200 },
        },
        at
      )
    );
    await adminAuditLogRepository.append(
      entry({ action: 'user.subscription.granted', details: { credits: -200 } }, at)
    );

    await expect(adminAuditLogRepository.sumCreditsGranted('admin-1', since)).resolves.toBe(100);
    await expect(
      adminAuditLogRepository.sumCreditsGranted('admin-1', since, { includeSubscriptionGrants: false })
    ).resolves.toBe(100);
    await expect(
      adminAuditLogRepository.sumCreditsGranted('admin-1', since, { includeSubscriptionGrants: true })
    ).resolves.toBe(1600);
    await expect(
      adminAuditLogRepository.sumCreditsGranted('admin-1', since, {
        excludeApproved: true,
        includeSubscriptionGrants: true,
      })
    ).resolves.toBe(700);
    await expect(adminAuditLogRepository.countCreditGrants('admin-1', { from: since, to: at })).resolves.toBe(1);
  });

  it('skips grants run on an approval only when asked', async () => {
    const since = new Date('2026-03-01T00:00:00Z');
    const at = new Date('2026-03-02T00:00:00Z');
    await adminAuditLogRepository.append(entry({ action: 'org.credits.granted', details: { credits: 100 } }, at));
    await adminAuditLogRepository.append(
      entry({ action: 'org.credits.granted', details: { credits: 900, approval: { id: 'approval-1' } } }, at)
    );

    await expect(adminAuditLogRepository.sumCreditsGranted('admin-1', since)).resolves.toBe(1000);
    await expect(adminAuditLogRepository.sumCreditsGranted('admin-1', since, { excludeApproved: true })).resolves.toBe(
      100
    );
  });
});

describe('AdminAuditLogRepository.sumCreditsGrantedTo', () => {
  setupMongoTest();

  const otherAdmin = {
    kind: 'user' as const,
    scope: 'platform' as const,
    userId: 'admin-2',
    name: 'Other',
    wasAdmin: true,
  };

  it('sums positive grants to one user from every admin, approved and subscription grants included', async () => {
    const since = new Date('2026-03-01T00:00:00Z');
    const at = new Date('2026-03-02T00:00:00Z');
    await adminAuditLogRepository.append(entry({ action: 'user.credits.adjusted', details: { credits: 100 } }, at));
    await adminAuditLogRepository.append(
      entry({ action: 'user.bulk.credits_adjusted', actor: otherAdmin, details: { credits: 200 } }, at)
    );
    await adminAuditLogRepository.append(
      entry({ action: 'user.subscription.granted', details: { credits: 400, approval: { id: 'approval-1' } } }, since)
    );
    // Not counted: a deduction, another user, an earlier grant, an org target and a non-grant action.
    await adminAuditLogRepository.append(entry({ action: 'user.credits.adjusted', details: { credits: -50 } }, at));
    await adminAuditLogRepository.append(
      entry(
        {
          action: 'user.credits.adjusted',
          target: { kind: 'user', id: 'someone-else', displayName: 'x' },
          details: { credits: 800 },
        },
        at
      )
    );
    await adminAuditLogRepository.append(
      entry({ action: 'user.credits.adjusted', details: { credits: 1600 } }, new Date(since.getTime() - 1))
    );
    await adminAuditLogRepository.append(
      entry(
        {
          action: 'org.credits.granted',
          target: { kind: 'organization', id: USER_ID, displayName: 'Org' },
          details: { credits: 3200 },
        },
        at
      )
    );
    await adminAuditLogRepository.append(entry({ action: 'user.credits.denied', details: { credits: 6400 } }, at));
    // Nor an undo (reversing a Contain restores credits), a signup release, or a team grant (counts on the org).
    await adminAuditLogRepository.append(entry({ action: 'user.bulk.undone', details: { credits: 12_800 } }, at));
    await adminAuditLogRepository.append(
      entry({ action: 'signup_domain_hold.released', details: { credits: 25_600 } }, at)
    );
    await adminAuditLogRepository.append(
      entry(
        {
          action: 'user.subscription.granted',
          organizationId: 'org-1',
          details: { credits: 51_200, subscriptionType: 'team' },
        },
        at
      )
    );

    await expect(adminAuditLogRepository.sumCreditsGrantedTo(USER_ID, since)).resolves.toBe(700);
    await expect(adminAuditLogRepository.sumCreditsGrantedTo('nobody', since)).resolves.toBe(0);
  });
});

describe('AdminAuditLogRepository.listCreditGrantsTo', () => {
  setupMongoTest();

  it('lists the newest counted grants in the window first, up to the limit', async () => {
    const since = new Date('2026-03-01T00:00:00Z');
    const hour = (n: number) => new Date(since.getTime() + n * 60 * 60 * 1000);
    for (const [credits, at] of [
      [100, hour(1)],
      [200, hour(4)],
      [300, hour(2)],
      [400, hour(3)],
    ] as const) {
      await adminAuditLogRepository.append(entry({ action: 'user.credits.adjusted', details: { credits } }, at));
    }
    // Not listed: before the window, a deduction, another user and a non-grant action.
    await adminAuditLogRepository.append(
      entry({ action: 'user.credits.adjusted', details: { credits: 800 } }, new Date(since.getTime() - 1))
    );
    await adminAuditLogRepository.append(
      entry({ action: 'user.credits.adjusted', details: { credits: -50 } }, hour(5))
    );
    await adminAuditLogRepository.append(
      entry(
        {
          action: 'user.credits.adjusted',
          target: { kind: 'user', id: 'someone-else', displayName: 'x' },
          details: { credits: 1600 },
        },
        hour(6)
      )
    );
    await adminAuditLogRepository.append(entry({ action: 'user.credits.denied', details: { credits: 3200 } }, hour(7)));

    const listed = await adminAuditLogRepository.listCreditGrantsTo(USER_ID, since, 3);

    expect(listed.map(row => row.details?.credits)).toEqual([200, 400, 300]);
    expect(listed[0]).toMatchObject({ occurredAt: hour(4), actor: { name: 'Admin' } });
    await expect(adminAuditLogRepository.listCreditGrantsTo(USER_ID, hour(3), 3)).resolves.toHaveLength(2);
  });
});

describe('AdminAuditLogRepository.sumCreditsGrantedToOrganization', () => {
  setupMongoTest();

  it('sums team grants to its members and grants targeting it, from every admin', async () => {
    const since = new Date('2026-03-01T00:00:00Z');
    const at = new Date('2026-03-02T00:00:00Z');
    const memberB = new Types.ObjectId().toHexString();
    const teamGrant = (credits: number, member: string) =>
      entry(
        {
          action: 'user.subscription.granted',
          target: { kind: 'user', id: member, displayName: 'member' },
          organizationId: ORG_ID,
          details: { subscriptionType: 'team', credits },
        },
        at
      );
    await adminAuditLogRepository.append(teamGrant(100, USER_ID));
    await adminAuditLogRepository.append(teamGrant(200, memberB));
    await adminAuditLogRepository.append(
      entry(
        {
          action: 'org.credits.granted',
          target: { kind: 'organization', id: ORG_ID, displayName: 'Org' },
          details: { credits: 400 },
        },
        at
      )
    );
    // Not counted: an org deduction, another organization, an earlier grant, a user grant without the org.
    await adminAuditLogRepository.append(
      entry(
        {
          action: 'org.credits.adjusted',
          target: { kind: 'organization', id: ORG_ID, displayName: 'Org' },
          details: { credits: -50 },
        },
        at
      )
    );
    await adminAuditLogRepository.append(
      entry(
        {
          action: 'user.subscription.granted',
          organizationId: new Types.ObjectId().toHexString(),
          details: { credits: 800 },
        },
        at
      )
    );
    await adminAuditLogRepository.append({ ...teamGrant(1600, USER_ID), occurredAt: new Date(since.getTime() - 1) });
    await adminAuditLogRepository.append(entry({ action: 'user.credits.adjusted', details: { credits: 3200 } }, at));

    await expect(adminAuditLogRepository.sumCreditsGrantedToOrganization(ORG_ID, since)).resolves.toBe(700);
    await expect(adminAuditLogRepository.sumCreditsGrantedToOrganization('nobody', since)).resolves.toBe(0);
  });
});

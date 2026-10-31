import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import type { NewAdminAuditEntry } from '@bike4mind/common';
import { setupMongoTest } from '../../../__test__/utils';
import { adminAuditLogRepository } from './AdminAuditLogModel';

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

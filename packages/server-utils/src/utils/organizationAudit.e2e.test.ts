import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { OrganizationAuditEventModel } from '@bike4mind/database/infra';
import { recordOrganizationAuditEvent } from './organizationAudit';
import { organizationAuditCsv, organizationAuditFilter, organizationAuditQuerySchema } from './organizationAuditRead';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let stop: () => Promise<unknown>;
beforeAll(async () => {
  const server = await createMongoServer();
  stop = () => server.stop();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await stop?.();
});
describe('persisted org audit boundary', () => {
  it('filters org and UTC range in storage, then exports exactly those records', async () => {
    await recordOrganizationAuditEvent({ organizationId: 'org-a', actorUserId: 'actor', action: 'policy.updated' });
    await OrganizationAuditEventModel.create([
      {
        organizationId: 'org-a',
        actorUserId: 'actor',
        action: 'policy.updated',
        occurredAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        organizationId: 'org-a',
        actorUserId: 'actor',
        action: 'policy.updated',
        occurredAt: new Date('2026-01-01T23:59:59.999Z'),
      },
      {
        organizationId: 'org-a',
        actorUserId: 'actor',
        action: 'policy.updated',
        occurredAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        organizationId: 'org-b',
        actorUserId: 'other-org',
        action: 'policy.updated',
        occurredAt: new Date('2026-01-01T12:00:00Z'),
      },
    ]);
    const query = organizationAuditQuerySchema.parse({ id: 'org-a', from: '2026-01-01', to: '2026-01-01' });
    const events = await OrganizationAuditEventModel.find(organizationAuditFilter(query)).lean();
    expect(events).toHaveLength(2);
    const csv = organizationAuditCsv(events);
    expect(csv).not.toContain('other-org');
    expect(csv).not.toContain('2026-01-02');
    expect(csv).toContain('2026-01-01T23:59:59.999Z');
    await expect(OrganizationAuditEventModel.updateMany({}, { $set: { actorUserId: 'rewrite' } })).rejects.toThrow(
      'append-only'
    );
    await expect(OrganizationAuditEventModel.deleteMany({})).rejects.toThrow('append-only');
  });
});

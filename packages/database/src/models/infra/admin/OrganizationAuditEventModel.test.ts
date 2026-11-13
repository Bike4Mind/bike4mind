import { describe, expect, it } from 'vitest';
import { OrganizationAuditEventModel } from './OrganizationAuditEventModel';

describe('org-only audit storage', () => {
  it('requires an org, an actor and an allowlisted action', async () => {
    await expect(
      new OrganizationAuditEventModel({ actorUserId: 'actor', action: 'policy.updated' }).validate()
    ).rejects.toThrow();
    await expect(
      new OrganizationAuditEventModel({
        organizationId: 'org',
        actorUserId: 'actor',
        action: 'admin.internal',
      }).validate()
    ).rejects.toThrow();
  });
  it('rejects internal audit payloads rather than retaining them', () => {
    expect(
      () =>
        new OrganizationAuditEventModel({
          organizationId: 'org',
          actorUserId: 'actor',
          action: 'policy.updated',
          details: { secret: 'no' },
        })
    ).toThrow();
  });
  it('indexes each read filter behind the organization boundary', () => {
    for (const [keys] of OrganizationAuditEventModel.schema.indexes())
      expect(Object.keys(keys)[0]).toBe('organizationId');
  });
});

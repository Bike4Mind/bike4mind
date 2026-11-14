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
  it('indexes erasure locators by actor while keeping organization reads tenant-scoped', () => {
    const indexes = OrganizationAuditEventModel.schema.indexes();
    const locators = indexes.filter(([, options]) => options.name === 'organization_export_erasure_locators');
    expect(locators).toHaveLength(1);
    expect(locators[0][0]).toEqual({ actorUserId: 1, action: 1, _id: 1 });
    expect(locators[0][1]).not.toHaveProperty('unique', true);
    expect(locators[0][1]).not.toHaveProperty('expireAfterSeconds');
    for (const [keys, options] of indexes) {
      if (options.name === 'organization_export_erasure_locators') continue;
      expect(Object.keys(keys)[0]).toBe('organizationId');
    }
  });
});

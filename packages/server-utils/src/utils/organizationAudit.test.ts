import { beforeEach, describe, expect, it, vi } from 'vitest';
const create = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/infra', () => ({
  ORGANIZATION_AUDIT_ACTIONS: ['policy.updated', 'api_key.created', 'api_key.revoked'],
  OrganizationAuditEventModel: { create },
}));
import { recordOrganizationAuditEvent } from './organizationAudit';

describe('organization audit writer contract', () => {
  beforeEach(() => vi.clearAllMocks());
  it('writes only the explicit org-visible envelope and server time', async () => {
    await recordOrganizationAuditEvent({ organizationId: 'org', actorUserId: 'actor', action: 'policy.updated' });
    expect(create).toHaveBeenCalledWith({
      organizationId: 'org',
      actorUserId: 'actor',
      action: 'policy.updated',
      occurredAt: expect.any(Date),
    });
  });
  it('rejects metadata and non-catalogued events at runtime', async () => {
    const input = {
      organizationId: 'org',
      actorUserId: 'actor',
      action: 'policy.updated' as const,
      details: { secret: 'not-stored' },
    };
    await expect(recordOrganizationAuditEvent(input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it('propagates persistence failures so a surrounding transaction can roll back', async () => {
    create.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
      recordOrganizationAuditEvent({ organizationId: 'org', actorUserId: 'actor', action: 'api_key.created' })
    ).rejects.toThrow('unavailable');
  });
});

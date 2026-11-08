import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_AUDIT_CREDIT_GRANT_ACTIONS } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  recordAdminAction: vi.fn(async () => null),
  policy: { singleGrantCredits: 1, dailyTotalCredits: 1, sumCreditsGranted: vi.fn() },
  loadCreditGrantPolicy: vi.fn(),
  auditLog: { append: vi.fn() },
}));

vi.mock('@bike4mind/database', () => ({ adminAuditLogRepository: h.auditLog, adminSettingsRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@bike4mind/services', () => ({ adminAuditService: { recordAdminAction: h.recordAdminAction } }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  loadCreditGrantPolicy: h.loadCreditGrantPolicy,
}));

import { systemAuditWriter } from './systemAuditWriter';

const target = { kind: 'user', id: 'user-1', displayName: 'user-1' };

describe('systemAuditWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.loadCreditGrantPolicy.mockResolvedValue(h.policy);
  });

  it('writes as the named system actor with a worker context, dropping any actor scope', async () => {
    await systemAuditWriter(
      'auto-containment',
      'security/autoContainment'
    )({
      action: 'user.tags.updated',
      target,
      summary: 'updated blockedEmailDomains',
      actorScope: 'organization',
    });

    expect(h.recordAdminAction).toHaveBeenCalledWith(
      {
        action: 'user.tags.updated',
        target,
        summary: 'updated blockedEmailDomains',
        actor: { kind: 'system', scope: 'platform', name: 'auto-containment', wasAdmin: false },
        context: { source: 'worker', route: 'security/autoContainment' },
      },
      { db: { adminAuditLog: h.auditLog }, creditGrantPolicy: undefined, logger: undefined }
    );
    expect(h.loadCreditGrantPolicy).not.toHaveBeenCalled();
  });

  it('loads the credit grant policy only for a credit grant action', async () => {
    const [grant] = ADMIN_AUDIT_CREDIT_GRANT_ACTIONS;
    await systemAuditWriter(
      'auto-containment',
      'security/autoContainment'
    )({ action: grant, target, summary: 'grant' });

    expect(h.loadCreditGrantPolicy).toHaveBeenCalledTimes(1);
    expect(h.recordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ creditGrantPolicy: h.policy })
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  reportKeptPersonalLakeShares: vi.fn(),
  notifyKeptPersonalLakeShares: vi.fn(),
  dataLakes: { kind: 'dataLakes' },
  dataLakeAccessGrants: { kind: 'dataLakeAccessGrants' },
  users: { kind: 'users' },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    reportKeptPersonalLakeShares: h.reportKeptPersonalLakeShares,
    notifyKeptPersonalLakeShares: h.notifyKeptPersonalLakeShares,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: h.dataLakes,
  dataLakeAccessGrantRepository: h.dataLakeAccessGrants,
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: h.users }));
vi.mock('./mailer', () => ({ default: { kind: 'mailer' } }));

import { reportAndNotifyKeptPersonalLakeShares } from './keptPersonalLakeSharesNotifier';

const ORG = {
  id: 'org-1',
  name: 'Acme',
  userId: 'owner-1',
  users: [
    { userId: 'member-2', permissions: ['read'] },
    // 'share' is a real Permission value, just not one of the two that confer membership.
    { userId: 'viewer-3', permissions: ['share'] },
  ],
};

describe('reportAndNotifyKeptPersonalLakeShares', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.reportKeptPersonalLakeShares.mockResolvedValue({ lakeCount: 0, byOwner: [] });
    h.notifyKeptPersonalLakeShares.mockResolvedValue(undefined);
  });

  it('derives member ids from the org doc: the billing owner plus users[] rows conferring membership', async () => {
    await reportAndNotifyKeptPersonalLakeShares('departed-1', ORG);

    expect(h.reportKeptPersonalLakeShares).toHaveBeenCalledWith(
      'departed-1',
      ['owner-1', 'member-2'],
      expect.anything()
    );
  });

  it('excludes a users[] row without a membership-conferring permission', async () => {
    await reportAndNotifyKeptPersonalLakeShares('departed-1', ORG);

    const [, memberIds] = h.reportKeptPersonalLakeShares.mock.calls[0];
    expect(memberIds).not.toContain('viewer-3');
  });

  it('returns null and logs at error level when the report read fails, without notifying', async () => {
    h.reportKeptPersonalLakeShares.mockRejectedValue(new Error('db down'));
    const error = vi.fn();
    const logger = { error, warn: vi.fn() } as unknown as Logger;

    const result = await reportAndNotifyKeptPersonalLakeShares('departed-1', ORG, logger);

    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ departedUserId: 'departed-1', organizationName: 'Acme' })
    );
    expect(h.notifyKeptPersonalLakeShares).not.toHaveBeenCalled();
  });

  it('returns the kept-share count and notifies owners on a successful report', async () => {
    const shares = { lakeCount: 2, byOwner: [{ ownerUserId: 'owner-1', lakes: [{ id: 'l1', name: 'Lake' }] }] };
    h.reportKeptPersonalLakeShares.mockResolvedValue(shares);

    const result = await reportAndNotifyKeptPersonalLakeShares('departed-1', ORG);

    expect(result).toBe(2);
    expect(h.notifyKeptPersonalLakeShares).toHaveBeenCalledWith(
      shares,
      expect.objectContaining({ departedUserId: 'departed-1', organizationName: 'Acme' }),
      expect.anything()
    );
  });
});

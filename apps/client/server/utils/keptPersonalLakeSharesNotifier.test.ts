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

describe('reportAndNotifyKeptPersonalLakeShares', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null and logs at error level when the report read fails, without notifying', async () => {
    h.reportKeptPersonalLakeShares.mockRejectedValue(new Error('db down'));
    const error = vi.fn();
    const logger = { error, warn: vi.fn() } as unknown as Logger;

    const result = await reportAndNotifyKeptPersonalLakeShares('departed-1', 'Acme', logger);

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
    h.notifyKeptPersonalLakeShares.mockResolvedValue(undefined);

    const result = await reportAndNotifyKeptPersonalLakeShares('departed-1', 'Acme');

    expect(result).toBe(2);
    expect(h.notifyKeptPersonalLakeShares).toHaveBeenCalledWith(
      shares,
      expect.objectContaining({ departedUserId: 'departed-1', organizationName: 'Acme' }),
      expect.anything()
    );
  });
});

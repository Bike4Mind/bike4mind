import { beforeEach, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => vi.fn());
vi.mock('@server/admin/approvals/service', () => ({ getApprovalPolicy: policy }));

import { creditGrantNeedsApproval } from './gate';

const ON = { enabled: true, bulkUserThreshold: 25, creditThreshold: 1000, expiryHours: 24 };

describe('creditGrantNeedsApproval', () => {
  beforeEach(() => policy.mockResolvedValue(ON));

  it('runs a grant at the threshold and gates one credit above it', async () => {
    expect(await creditGrantNeedsApproval(1000)).toBeNull();
    expect(await creditGrantNeedsApproval(1001)).toEqual(ON);
  });

  it('never gates while approvals are off', async () => {
    policy.mockResolvedValue({ ...ON, enabled: false });
    expect(await creditGrantNeedsApproval(10_000_000)).toBeNull();
  });
});

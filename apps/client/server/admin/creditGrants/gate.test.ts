// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ policy: vi.fn(), sum: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ adminAuditLogRepository: { sumCreditsGranted: mocks.sum } }));
vi.mock('@server/admin/approvals/service', () => ({ getApprovalPolicy: mocks.policy }));

import { creditGrantNeedsApproval } from './gate';

const POLICY = { enabled: true, creditThreshold: 1000, expiryHours: 24 };

describe('creditGrantNeedsApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.policy.mockResolvedValue(POLICY);
    mocks.sum.mockResolvedValue(0);
  });

  it('holds a single grant over the threshold, and runs one at it', async () => {
    expect(await creditGrantNeedsApproval(1001, 'admin1')).toBe(POLICY);
    expect(await creditGrantNeedsApproval(1000, 'admin1')).toBeNull();
  });

  it("adds this admin's grants over the expiry window to the threshold check", async () => {
    mocks.sum.mockResolvedValue(600);
    expect(await creditGrantNeedsApproval(500, 'admin1')).toBe(POLICY);
    const [actor, since] = mocks.sum.mock.calls[0] as [string, Date];
    expect(actor).toBe('admin1');
    expect(Date.now() - since.getTime()).toBeCloseTo(24 * 60 * 60 * 1000, -4);
    mocks.sum.mockResolvedValue(500);
    expect(await creditGrantNeedsApproval(500, 'admin1')).toBeNull();
  });

  it('never holds a refund or anything while approvals are off', async () => {
    mocks.sum.mockResolvedValue(5000);
    expect(await creditGrantNeedsApproval(-50, 'admin1')).toBeNull();
    mocks.policy.mockResolvedValue({ ...POLICY, enabled: false });
    expect(await creditGrantNeedsApproval(5000, 'admin1')).toBeNull();
    expect(mocks.sum).not.toHaveBeenCalled();
  });
});

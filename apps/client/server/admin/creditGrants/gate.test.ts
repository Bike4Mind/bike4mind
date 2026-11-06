// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ policy: vi.fn(), sum: vi.fn() }));

const reservations = vi.hoisted(() => {
  const rows = new Map<string, { actorUserId: string; kind: string; amount: number }>();
  let next = 0;
  return {
    rows,
    reserve: vi.fn(async (actorUserId: string, kind: string, amount: number) => {
      const id = String(++next);
      rows.set(id, { actorUserId, kind, amount });
      return id;
    }),
    sumReserved: vi.fn(async (actorUserId: string, kind: string) =>
      [...rows.values()].filter(r => r.actorUserId === actorUserId && r.kind === kind).reduce((t, r) => t + r.amount, 0)
    ),
    release: vi.fn(async (id: string) => void rows.delete(id)),
  };
});
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { sumCreditsGranted: mocks.sum },
  adminGateReservationRepository: reservations,
}));
vi.mock('@server/admin/approvals/service', () => ({ getApprovalPolicy: mocks.policy }));

import { creditGrantNeedsApproval } from './gate';

const POLICY = { enabled: true, creditThreshold: 1000, expiryHours: 24 };

describe('creditGrantNeedsApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reservations.rows.clear();
    mocks.policy.mockResolvedValue(POLICY);
    mocks.sum.mockResolvedValue(0);
  });

  it('holds a single grant over the threshold, and runs one at it', async () => {
    expect(await creditGrantNeedsApproval(1001, 'admin1')).toEqual({ policy: POLICY });
    expect(await creditGrantNeedsApproval(1000, 'admin1')).toMatchObject({ policy: null });
  });

  it("adds this admin's grants over the expiry window to the threshold check", async () => {
    mocks.sum.mockResolvedValue(600);
    expect(await creditGrantNeedsApproval(500, 'admin1')).toEqual({ policy: POLICY });
    const [actor, since, options] = mocks.sum.mock.calls[0] as [string, Date, { excludeApproved?: boolean }];
    expect(actor).toBe('admin1');
    expect(options).toEqual({ excludeApproved: true });
    expect(Date.now() - since.getTime()).toBeCloseTo(24 * 60 * 60 * 1000, -4);
    mocks.sum.mockResolvedValue(500);
    expect(await creditGrantNeedsApproval(500, 'admin1')).toMatchObject({ policy: null });
  });

  it('never holds a refund or anything while approvals are off', async () => {
    mocks.sum.mockResolvedValue(5000);
    expect(await creditGrantNeedsApproval(-50, 'admin1')).toMatchObject({ policy: null });
    mocks.policy.mockResolvedValue({ ...POLICY, enabled: false });
    expect(await creditGrantNeedsApproval(5000, 'admin1')).toMatchObject({ policy: null });
    expect(mocks.sum).not.toHaveBeenCalled();
  });
});

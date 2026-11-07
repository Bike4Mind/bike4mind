// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ policy: vi.fn(), sum: vi.fn() }));
const logger = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: logger } }));

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

import { creditGrantNeedsApproval, reserveWithinWindow } from './gate';

const POLICY = { enabled: true, creditThreshold: 1000, expiryHours: 24 };

describe('creditGrantNeedsApproval', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    reservations.reserve.mockImplementation(async (actorUserId: string, kind: string, amount: number) => {
      const id = String(reservations.rows.size + 1);
      reservations.rows.set(id, { actorUserId, kind, amount });
      return id;
    });
    reservations.sumReserved.mockImplementation(async (actorUserId: string, kind: string) =>
      [...reservations.rows.values()]
        .filter(row => row.actorUserId === actorUserId && row.kind === kind)
        .reduce((total, row) => total + row.amount, 0)
    );
    reservations.release.mockImplementation(async (id: string) => void reservations.rows.delete(id));
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
    const [actor, since, options] = mocks.sum.mock.calls[0] as [
      string,
      Date,
      { excludeApproved?: boolean; includeSubscriptionGrants?: boolean },
    ];
    expect(actor).toBe('admin1');
    expect(options).toEqual({ excludeApproved: true, includeSubscriptionGrants: true });
    expect(Date.now() - since.getTime()).toBeCloseTo(24 * 60 * 60 * 1000, -4);
    mocks.sum.mockResolvedValue(500);
    expect(await creditGrantNeedsApproval(500, 'admin1')).toMatchObject({ policy: null });
  });

  it('holds the next grant after a subscription grant commits and its reservation releases', async () => {
    const first = await creditGrantNeedsApproval(600, 'admin1');
    expect(first.policy).toBeNull();
    if (first.policy) throw new Error('Expected the first grant to run');
    await first.release();
    mocks.sum.mockImplementation(
      async (_actor: string, _since: Date, options: { includeSubscriptionGrants?: boolean }) =>
        options.includeSubscriptionGrants ? 600 : 0
    );

    expect(await creditGrantNeedsApproval(600, 'admin1')).toEqual({ policy: POLICY });
    expect(reservations.rows.size).toBe(0);
  });

  it('never holds a refund or anything while approvals are off', async () => {
    mocks.sum.mockResolvedValue(5000);
    expect(await creditGrantNeedsApproval(-50, 'admin1')).toMatchObject({ policy: null });
    mocks.policy.mockResolvedValue({ ...POLICY, enabled: false });
    expect(await creditGrantNeedsApproval(5000, 'admin1')).toMatchObject({ policy: null });
    expect(mocks.sum).not.toHaveBeenCalled();
  });

  it('counts an action that commits and releases while the next reservation is read', async () => {
    let audited = 0;
    reservations.rows.set('running', { actorUserId: 'admin1', kind: 'credits', amount: 600 });
    reservations.sumReserved.mockImplementationOnce(async () => {
      audited = 600;
      reservations.rows.delete('running');
      return 600;
    });
    const recorded = vi.fn(async () => audited);

    expect(await reserveWithinWindow('admin1', 'credits', 600, 1000, 60_000, recorded)).toBeNull();
    expect(recorded).toHaveBeenCalledOnce();
    expect(reservations.rows.size).toBe(0);
  });

  it('logs a failed release and preserves the original read error', async () => {
    const readError = new Error('audit unavailable');
    const releaseError = new Error('release unavailable');
    reservations.release.mockRejectedValueOnce(releaseError);
    mocks.sum.mockRejectedValueOnce(readError);

    await expect(creditGrantNeedsApproval(600, 'admin1')).rejects.toBe(readError);
    expect(logger.error).toHaveBeenCalledWith('[ADMIN_GATE_RESERVATION_RELEASE_FAILED]', {
      reservationId: expect.any(String),
      error: releaseError,
    });
  });
});

import { applyPartnerRuleMembership } from './applyPartnerRuleMembership';
import { Permission } from '@bike4mind/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cloneDeep } from 'lodash';

describe('applyPartnerRuleMembership', () => {
  const verifiedUser = { id: 'user-id', name: 'Test User', email: 'test@partner.com', emailVerified: true };
  // No stripeCustomerId => a non-Stripe (admin-granted) org, which raises the seat ceiling to fit.
  const org = { id: 'org-id', name: 'Partner Org', seats: 5, users: [] as Array<{ userId: string }> };
  const stripeOrg = { ...org, stripeCustomerId: 'cus_123' };

  let db: any;
  let logger: any;

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      users: { findById: vi.fn(), update: vi.fn() },
      organizations: {
        findById: vi.fn(),
        addMemberRaisingSeats: vi.fn(),
        addMemberIfUnderCeiling: vi.fn(),
      },
    };
    logger = { info: vi.fn() };
  });

  const run = () => applyPartnerRuleMembership({ userId: 'user-id', organizationId: 'org-id' }, { db, logger });

  it('adds a verified user that fits under the ceiling as a read-permission member and sets organizationId', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    db.organizations.findById.mockResolvedValue(cloneDeep(org));
    // addMemberRaisingSeats returns the PRE-image (users empty, seats 5); fits, so seats unchanged.
    db.organizations.addMemberRaisingSeats.mockResolvedValue(cloneDeep(org));

    const result = await run();

    expect(result).toEqual({ added: true, reason: 'added', previousSeats: 5, newSeats: 5 });
    expect(db.organizations.addMemberRaisingSeats).toHaveBeenCalledWith('org-id', {
      userId: 'user-id',
      permissions: [Permission.read],
    });
    expect(db.organizations.addMemberIfUnderCeiling).not.toHaveBeenCalled();
    expect(db.users.update).toHaveBeenCalledWith({ id: 'user-id', organizationId: 'org-id' });
  });

  it('raises the seat ceiling to admit a user at capacity instead of rejecting (#1239)', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    const full = { ...cloneDeep(org), seats: 2, users: [{ userId: 'a' }, { userId: 'b' }] };
    db.organizations.findById.mockResolvedValue(full);
    // PRE-image: 2 members, seats 2. The service derives newSeats = max(2, 2 + 1) = 3.
    db.organizations.addMemberRaisingSeats.mockResolvedValue(cloneDeep(full));

    const result = await run();

    expect(result).toEqual({ added: true, reason: 'added-seat-raised', previousSeats: 2, newSeats: 3 });
    expect(db.users.update).toHaveBeenCalledWith({ id: 'user-id', organizationId: 'org-id' });
  });

  it('reports the seat range from the atomic PRE-IMAGE, not the earlier read (concurrent raise)', async () => {
    // Guards the fix for the reported race: deriving previousSeats/newSeats from the top-of-function
    // findById makes two racers report OVERLAPPING ranges (2->3 and 2->4), so an operator
    // reconciling seat growth double-counts the 2->3 interval. The two mocks must therefore
    // disagree, or the test cannot tell the two sources apart.
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    // Stale read: what this caller saw before a concurrent signup landed.
    db.organizations.findById.mockResolvedValue({
      ...cloneDeep(org),
      seats: 2,
      users: [{ userId: 'a' }, { userId: 'b' }],
    });
    // Atomic pre-image: a racer already added a third member and raised seats to 3.
    db.organizations.addMemberRaisingSeats.mockResolvedValue({
      ...cloneDeep(org),
      seats: 3,
      users: [{ userId: 'a' }, { userId: 'b' }, { userId: 'racer' }],
    });

    const result = await run();

    // From the pre-image: 3 -> max(3, 3 + 1) = 4. From the stale read it would be 2 -> 3.
    expect(result).toEqual({ added: true, reason: 'added-seat-raised', previousSeats: 3, newSeats: 4 });
  });

  it('adds a Stripe-billed org member that fits WITHOUT raising the ceiling', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    const fits = { ...cloneDeep(stripeOrg), seats: 5, users: [{ userId: 'a' }] };
    db.organizations.findById.mockResolvedValue(fits);
    db.organizations.addMemberIfUnderCeiling.mockResolvedValue(cloneDeep(fits));

    const result = await run();

    expect(result).toEqual({ added: true, reason: 'added', previousSeats: 5, newSeats: 5 });
    expect(db.organizations.addMemberIfUnderCeiling).toHaveBeenCalledWith('org-id', {
      userId: 'user-id',
      permissions: [Permission.read],
    });
    // A Stripe org's ceiling is never raised out of band.
    expect(db.organizations.addMemberRaisingSeats).not.toHaveBeenCalled();
    expect(db.users.update).toHaveBeenCalledWith({ id: 'user-id', organizationId: 'org-id' });
  });

  it('rejects with at-capacity (no write) when a full Stripe-billed org cannot fit the user', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    const full = { ...cloneDeep(stripeOrg), seats: 2, users: [{ userId: 'a' }, { userId: 'b' }] };
    // Top-of-function read, then the re-read after the atomic add matches nothing.
    db.organizations.findById.mockResolvedValue(full);
    db.organizations.addMemberIfUnderCeiling.mockResolvedValue(null);

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'at-capacity', seats: 2 });
    expect(db.organizations.addMemberRaisingSeats).not.toHaveBeenCalled();
    expect(db.users.update).not.toHaveBeenCalled();
  });

  it('reports already-member when a Stripe-billed add loses the race to a concurrent signup', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    // First read: user absent. addMemberIfUnderCeiling returns null (raced). Re-read: user now present.
    db.organizations.findById
      .mockResolvedValueOnce({ ...cloneDeep(stripeOrg), seats: 5, users: [{ userId: 'a' }] })
      .mockResolvedValueOnce({ ...cloneDeep(stripeOrg), seats: 5, users: [{ userId: 'a' }, { userId: 'user-id' }] });
    db.organizations.addMemberIfUnderCeiling.mockResolvedValue(null);

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'already-member' });
    expect(db.users.update).toHaveBeenCalledWith({ id: 'user-id', organizationId: 'org-id' });
  });

  it('refuses to add an unverified user (security gate) and writes nothing', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, emailVerified: false });

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'unverified' });
    expect(db.organizations.findById).not.toHaveBeenCalled();
    expect(db.organizations.addMemberRaisingSeats).not.toHaveBeenCalled();
    expect(db.organizations.addMemberIfUnderCeiling).not.toHaveBeenCalled();
    expect(db.users.update).not.toHaveBeenCalled();
  });

  it('no-ops when the user is missing', async () => {
    db.users.findById.mockResolvedValue(null);
    expect(await run()).toEqual({ added: false, reason: 'user-missing' });
    expect(db.organizations.addMemberRaisingSeats).not.toHaveBeenCalled();
  });

  it('fails safe when the org is missing (e.g. soft-deleted)', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser });
    db.organizations.findById.mockResolvedValue(null);

    expect(await run()).toEqual({ added: false, reason: 'org-missing' });
    expect(db.organizations.addMemberRaisingSeats).not.toHaveBeenCalled();
    expect(db.users.update).not.toHaveBeenCalled();
  });

  it('is idempotent: an existing member is not duplicated', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: 'org-id' });
    db.organizations.findById.mockResolvedValue({ ...cloneDeep(org), users: [{ userId: 'user-id' }] });

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'already-member' });
    expect(db.organizations.addMemberRaisingSeats).not.toHaveBeenCalled();
    expect(db.users.update).not.toHaveBeenCalled();
  });

  it('repairs a half-set membership: in users[] but organizationId unset', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    db.organizations.findById.mockResolvedValue({ ...cloneDeep(org), users: [{ userId: 'user-id' }] });

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'already-member' });
    expect(db.organizations.addMemberRaisingSeats).not.toHaveBeenCalled();
    expect(db.users.update).toHaveBeenCalledWith({ id: 'user-id', organizationId: 'org-id' });
  });

  it('reports already-member (and repairs the pointer) when the atomic add loses a race', async () => {
    // findById saw an open seat, but a concurrent signup added this user first, so the atomic
    // guarded update matched no doc and returned null. The re-read shows the user is now a member.
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    db.organizations.findById
      .mockResolvedValueOnce(cloneDeep(org))
      .mockResolvedValueOnce({ ...cloneDeep(org), users: [{ userId: 'user-id' }] });
    db.organizations.addMemberRaisingSeats.mockResolvedValue(null);

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'already-member' });
    expect(db.users.update).toHaveBeenCalledWith({ id: 'user-id', organizationId: 'org-id' });
  });

  it('does NOT write an org pointer when the org was hard-deleted between read and atomic add (#P3)', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    // Present at the top read, gone by the re-read after the add matched nothing.
    db.organizations.findById.mockResolvedValueOnce(cloneDeep(org)).mockResolvedValueOnce(null);
    db.organizations.addMemberRaisingSeats.mockResolvedValue(null);

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'org-missing' });
    // Never point the user at an org that vanished mid-flight.
    expect(db.users.update).not.toHaveBeenCalled();
  });
});

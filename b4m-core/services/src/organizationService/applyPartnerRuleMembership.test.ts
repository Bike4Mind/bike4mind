import { applyPartnerRuleMembership } from './applyPartnerRuleMembership';
import { Permission } from '@bike4mind/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cloneDeep } from 'lodash';

describe('applyPartnerRuleMembership', () => {
  const verifiedUser = { id: 'user-id', name: 'Test User', email: 'test@partner.com', emailVerified: true };
  const org = { id: 'org-id', name: 'Partner Org', seats: 5, users: [] as Array<{ userId: string }> };

  let db: any;
  let logger: any;

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      users: { findById: vi.fn(), update: vi.fn() },
      organizations: { findById: vi.fn(), update: vi.fn() },
    };
    logger = { info: vi.fn() };
  });

  const run = () => applyPartnerRuleMembership({ userId: 'user-id', organizationId: 'org-id' }, { db, logger });

  it('adds a verified user to the org as a read-permission member and sets organizationId', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    db.organizations.findById.mockResolvedValue(cloneDeep(org));

    const result = await run();

    expect(result).toEqual({ added: true, reason: 'added' });
    expect(db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({ users: [{ userId: 'user-id', permissions: [Permission.read] }] })
    );
    expect(db.users.update).toHaveBeenCalledWith({ id: 'user-id', organizationId: 'org-id' });
  });

  it('refuses to add an unverified user (security gate) and writes nothing', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, emailVerified: false });

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'unverified' });
    expect(db.organizations.findById).not.toHaveBeenCalled();
    expect(db.organizations.update).not.toHaveBeenCalled();
    expect(db.users.update).not.toHaveBeenCalled();
  });

  it('no-ops when the user is missing', async () => {
    db.users.findById.mockResolvedValue(null);
    expect(await run()).toEqual({ added: false, reason: 'user-missing' });
    expect(db.organizations.update).not.toHaveBeenCalled();
  });

  it('fails safe when the org is missing (e.g. soft-deleted)', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser });
    db.organizations.findById.mockResolvedValue(null);

    expect(await run()).toEqual({ added: false, reason: 'org-missing' });
    expect(db.organizations.update).not.toHaveBeenCalled();
    expect(db.users.update).not.toHaveBeenCalled();
  });

  it('is idempotent: an existing member is not duplicated', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: 'org-id' });
    db.organizations.findById.mockResolvedValue({ ...cloneDeep(org), users: [{ userId: 'user-id' }] });

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'already-member' });
    expect(db.organizations.update).not.toHaveBeenCalled();
    expect(db.users.update).not.toHaveBeenCalled();
  });

  it('repairs a half-set membership: in users[] but organizationId unset', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser, organizationId: null });
    db.organizations.findById.mockResolvedValue({ ...cloneDeep(org), users: [{ userId: 'user-id' }] });

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'already-member' });
    expect(db.organizations.update).not.toHaveBeenCalled();
    expect(db.users.update).toHaveBeenCalledWith({ id: 'user-id', organizationId: 'org-id' });
  });

  it('does not overfill an at-capacity org (no silent seat overflow)', async () => {
    db.users.findById.mockResolvedValue({ ...verifiedUser });
    db.organizations.findById.mockResolvedValue({
      ...cloneDeep(org),
      seats: 2,
      users: [{ userId: 'a' }, { userId: 'b' }],
    });

    const result = await run();

    expect(result).toEqual({ added: false, reason: 'at-capacity' });
    expect(db.organizations.update).not.toHaveBeenCalled();
    expect(db.users.update).not.toHaveBeenCalled();
  });
});

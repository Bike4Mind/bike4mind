import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { createMockOrganizationRepository } from '../__tests__/utils/testUtils';
import { setMemberCreditDefault, setMemberCreditOverride } from './memberCreditBudget';

const actor = (id: string, isAdmin = false) => ({ id, isAdmin }) as unknown as IUserDocument;

const org = (overrides: Partial<IOrganizationDocument> = {}) =>
  ({
    id: 'org1',
    userId: 'owner1',
    adminUserIds: ['orgAdmin1'],
    users: [{ userId: 'member1', permissions: ['read'] }],
    userDetails: [{ id: 'member1', name: 'M', usedCredits: 0, lastCreditUsedAt: null, maxCredits: 25 }],
    maxCreditsPerMember: 100,
    ...overrides,
  }) as unknown as IOrganizationDocument;

describe('setMemberCreditDefault', () => {
  let organizations: ReturnType<typeof createMockOrganizationRepository>;

  beforeEach(() => {
    organizations = createMockOrganizationRepository();
    organizations.findById.mockResolvedValue(org());
    organizations.update.mockImplementation(async (update: Partial<IOrganizationDocument>) => ({
      ...org(),
      ...update,
    }));
  });

  it.each([
    ['billing owner', actor('owner1')],
    ['appointed org admin', actor('orgAdmin1')],
    ['platform admin', actor('stranger', true)],
  ])('lets the %s set the default and reports before/after', async (_label, caller) => {
    const change = await setMemberCreditDefault(
      caller,
      { organizationId: 'org1', maxCreditsPerMember: 500 },
      { db: { organizations } }
    );

    expect(organizations.update).toHaveBeenCalledWith({ id: 'org1', maxCreditsPerMember: 500 });
    expect(change).toMatchObject({ previous: 100, current: 500 });
    expect(change.organization.maxCreditsPerMember).toBe(500);
  });

  it('clears the default with null (persisted as null, not dropped as undefined)', async () => {
    await setMemberCreditDefault(
      actor('owner1'),
      { organizationId: 'org1', maxCreditsPerMember: null },
      { db: { organizations } }
    );
    expect(organizations.update).toHaveBeenCalledWith({ id: 'org1', maxCreditsPerMember: null });
  });

  it('refuses a plain member with the same NotFoundError as a missing org, and does not write', async () => {
    await expect(
      setMemberCreditDefault(
        actor('member1'),
        { organizationId: 'org1', maxCreditsPerMember: 500 },
        { db: { organizations } }
      )
    ).rejects.toThrow(NotFoundError);
    expect(organizations.update).not.toHaveBeenCalled();

    organizations.findById.mockResolvedValue(null);
    await expect(
      setMemberCreditDefault(
        actor('owner1'),
        { organizationId: 'org1', maxCreditsPerMember: 500 },
        { db: { organizations } }
      )
    ).rejects.toThrow(NotFoundError);
  });

  it.each([0, -5, Number.POSITIVE_INFINITY])('rejects a non-positive or infinite default (%s)', async value => {
    await expect(
      setMemberCreditDefault(
        actor('owner1'),
        { organizationId: 'org1', maxCreditsPerMember: value },
        { db: { organizations } }
      )
    ).rejects.toThrow();
    expect(organizations.update).not.toHaveBeenCalled();
  });
});

describe('setMemberCreditOverride', () => {
  let organizations: ReturnType<typeof createMockOrganizationRepository>;
  const users = { findById: vi.fn() };

  beforeEach(() => {
    organizations = createMockOrganizationRepository();
    organizations.findById.mockResolvedValue(org());
    organizations.setMemberMaxCredits.mockResolvedValue(true);
    users.findById.mockReset();
  });

  const run = (caller: IUserDocument, userId: string, maxCredits: number | null) =>
    setMemberCreditOverride(caller, { organizationId: 'org1', userId, maxCredits }, { db: { organizations, users } });

  it('sets an override on an existing row and reports the previous override', async () => {
    const change = await run(actor('orgAdmin1'), 'member1', 0);

    expect(organizations.setMemberMaxCredits).toHaveBeenCalledWith('org1', 'member1', 0);
    expect(organizations.ensureUserDetails).not.toHaveBeenCalled();
    expect(change).toMatchObject({ previous: 25, current: 0 });
  });

  it('clears an override with null so the member inherits the org default', async () => {
    await run(actor('owner1'), 'member1', null);
    expect(organizations.setMemberMaxCredits).toHaveBeenCalledWith('org1', 'member1', null);
  });

  it('seeds the userDetails row first for a member who predates its seeding', async () => {
    organizations.findById.mockResolvedValue(org({ userDetails: [] }));
    users.findById.mockResolvedValue({ id: 'member1', email: 'm@example.com', name: 'M' });

    const change = await run(actor('owner1'), 'member1', 50);

    expect(organizations.ensureUserDetails).toHaveBeenCalledWith('org1', {
      id: 'member1',
      email: 'm@example.com',
      name: 'M',
    });
    expect(organizations.setMemberMaxCredits).toHaveBeenCalledWith('org1', 'member1', 50);
    expect(change.previous).toBeNull();
  });

  it('refuses a target who is not a current member of the org, and does not write', async () => {
    await expect(run(actor('owner1'), 'outsider', 50)).rejects.toThrow('Member not found');
    expect(organizations.setMemberMaxCredits).not.toHaveBeenCalled();
    expect(organizations.ensureUserDetails).not.toHaveBeenCalled();
  });

  it('refuses a caller who cannot manage budgets, even for their own row', async () => {
    await expect(run(actor('member1'), 'member1', 1_000_000)).rejects.toThrow(NotFoundError);
    expect(organizations.setMemberMaxCredits).not.toHaveBeenCalled();
  });

  it('surfaces a row that vanished between seed and write as NotFound rather than a silent no-op', async () => {
    organizations.setMemberMaxCredits.mockResolvedValue(false);
    await expect(run(actor('owner1'), 'member1', 50)).rejects.toThrow('Member not found');
  });

  it.each([-1, Number.NaN])('rejects a negative or non-numeric override (%s)', async value => {
    await expect(run(actor('owner1'), 'member1', value)).rejects.toThrow();
    expect(organizations.setMemberMaxCredits).not.toHaveBeenCalled();
  });
});

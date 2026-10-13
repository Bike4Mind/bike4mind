import {
  IOrganizationDocument,
  IOrganizationRepository,
  IUserDocument,
  IUserRepository,
  canManageMemberCreditBudgets,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { isCurrentOrgMember } from './orgAuthority';

/**
 * Writes for the org's monthly per-member credit budget (see `creditService/memberCreditCap.ts`
 * for how it is enforced). Both are gated by `canManageMemberCreditBudgets`, and both refuse an
 * unauthorized caller with the same NotFoundError as a missing org, so neither route is an
 * existence oracle (matches `addMember` / `revokeAccess`).
 */

const setDefaultSchema = z.object({
  organizationId: z.string().min(1),
  // null clears the default (uncapped). Positive, like the existing org update field: a 0 default
  // would silently freeze every member, which a per-member override of 0 can do deliberately.
  maxCreditsPerMember: z.number().int().positive().nullable(),
});

const setOverrideSchema = z.object({
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  // null inherits the org default; 0 blocks this member's spend from the pool.
  maxCredits: z.number().int().nonnegative().nullable(),
});

type CreditBudgetChange = {
  organization: IOrganizationDocument;
  previous: number | null;
  current: number | null;
};

async function findManageableOrganization(
  actor: IUserDocument,
  organizationId: string,
  organizations: IOrganizationRepository
): Promise<IOrganizationDocument> {
  const organization = await organizations.findById(organizationId);
  if (!organization || !canManageMemberCreditBudgets(actor, organization)) {
    throw new NotFoundError('Organization not found');
  }
  return organization;
}

/** Set (or clear, with null) the org's default monthly per-member credit budget. */
export async function setMemberCreditDefault(
  actor: IUserDocument,
  parameters: z.infer<typeof setDefaultSchema>,
  adapters: { db: { organizations: IOrganizationRepository } }
): Promise<CreditBudgetChange> {
  const { organizationId, maxCreditsPerMember } = secureParameters(parameters, setDefaultSchema);
  const { organizations } = adapters.db;
  const organization = await findManageableOrganization(actor, organizationId, organizations);

  const updated = await organizations.update({ id: organizationId, maxCreditsPerMember });
  return {
    organization: updated ?? { ...organization, maxCreditsPerMember },
    previous: organization.maxCreditsPerMember ?? null,
    current: maxCreditsPerMember,
  };
}

/**
 * Set (or clear, with null) one member's monthly credit budget override. Seeds the member's
 * `userDetails` row first when they predate its seeding, since the override lives on that row.
 */
export async function setMemberCreditOverride(
  actor: IUserDocument,
  parameters: z.infer<typeof setOverrideSchema>,
  adapters: { db: { organizations: IOrganizationRepository; users: Pick<IUserRepository, 'findById'> } }
): Promise<CreditBudgetChange> {
  const { organizationId, userId, maxCredits } = secureParameters(parameters, setOverrideSchema);
  const { organizations, users } = adapters.db;
  const organization = await findManageableOrganization(actor, organizationId, organizations);

  if (!isCurrentOrgMember(organization, userId)) throw new NotFoundError('Member not found');

  const existing = organization.userDetails?.find(details => details.id === userId);
  if (!existing) {
    const member = await users.findById(userId);
    if (!member) throw new NotFoundError('Member not found');
    await organizations.ensureUserDetails(organizationId, {
      id: member.id,
      email: member.email ?? member.username,
      name: member.name,
    });
  }

  if (!(await organizations.setMemberMaxCredits(organizationId, userId, maxCredits))) {
    // The member was removed (or their row vanished) between the membership check and this write.
    throw new NotFoundError('Member not found');
  }

  const updated = await organizations.findById(organizationId);
  return {
    organization: updated ?? organization,
    previous: existing?.maxCredits ?? null,
    current: maxCredits,
  };
}

import { IOrganizationRepository, IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';

const updateSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  billingContact: z.string().optional(),
  currentCredits: z.coerce.number().optional(),
  systemPrompt: z.string().max(10000).optional(), // ~2500 tokens
  maxCreditsPerMember: z.number().positive().nullable().optional(),
});

type UpdateParameters = z.infer<typeof updateSchema>;

interface UpdateAdapters {
  db: {
    organizations: IOrganizationRepository;
  };
}

export const update = async (user: IUserDocument, params: UpdateParameters, adapters: UpdateAdapters) => {
  const { id, ...rest } = secureParameters(params, updateSchema);

  let organization = await adapters.db.organizations.shareable.findUpdateAccessById(user, id);
  if (user.isAdmin) {
    organization = await adapters.db.organizations.findById(id);
  }

  if (!organization) throw new NotFoundError('Organization not found');

  const isManager = organization.managerId === user.id;
  const isOwner = organization.userId === user.id;

  organization = {
    ...organization,
    name: rest.name ?? organization.name,
    description: rest.description ?? organization.description,
    // Only allow billing contact changes for owners and admins, not managers
    billingContact:
      isManager && !isOwner && !user.isAdmin
        ? organization.billingContact
        : (rest.billingContact ?? organization.billingContact),
    // Managers can update systemPrompt intentionally - they customize org-wide AI
    // behavior. Authorization is already checked via findUpdateAccessById.
    systemPrompt: rest.systemPrompt ?? organization.systemPrompt,
    updatedAt: new Date(),
  };

  if (user.isAdmin && rest.currentCredits !== undefined) {
    organization.currentCredits = rest.currentCredits;
  }

  // Only admins can set per-member credit caps
  if (user.isAdmin && rest.maxCreditsPerMember !== undefined) {
    organization.maxCreditsPerMember = rest.maxCreditsPerMember ?? undefined;
  }

  await adapters.db.organizations.update(organization);

  return organization;
};

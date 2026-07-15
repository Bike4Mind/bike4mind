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

  // Normalize a possibly-hydrated Mongoose doc to a plain object before spreading.
  // findUpdateAccessById returns a hydrated doc (unlike findAccessibleById, which
  // returns toJSON()); spreading it copies `_doc`/`$__` and nests the real fields,
  // which corrupts the response shape AND defeats the response-boundary field strip
  // in toSafeOrganization (top-level stripeCustomerId/userId would be undefined).
  const plain = (
    typeof (organization as { toJSON?: unknown }).toJSON === 'function'
      ? (organization as { toJSON: () => typeof organization }).toJSON()
      : organization
  ) as NonNullable<typeof organization>;

  const isManager = plain.managerId === user.id;
  const isOwner = plain.userId === user.id;

  organization = {
    ...plain,
    name: rest.name ?? plain.name,
    description: rest.description ?? plain.description,
    // Only allow billing contact changes for owners and admins, not managers
    billingContact:
      isManager && !isOwner && !user.isAdmin
        ? plain.billingContact
        : (rest.billingContact ?? plain.billingContact),
    // Managers can update systemPrompt intentionally - they customize org-wide AI
    // behavior. Authorization is already checked via findUpdateAccessById.
    systemPrompt: rest.systemPrompt ?? plain.systemPrompt,
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

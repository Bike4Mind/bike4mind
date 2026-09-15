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
      ? (organization as unknown as { toJSON: () => NonNullable<typeof organization> }).toJSON()
      : organization
  ) as NonNullable<typeof organization>;

  const isManager = plain.managerId === user.id;
  const isOwner = plain.userId === user.id;

  // Persist ONLY the caller-editable fields this request changed, never a spread of
  // the read snapshot. A whole-document write reverted concurrent credit, seat and
  // membership writes; currentCredits/seats/users[]/userDetails[] are never round-tripped.
  const update: Partial<typeof plain> & { id: string } = { id };
  if (rest.name !== undefined) update.name = rest.name;
  if (rest.description !== undefined) update.description = rest.description;
  // Only allow billing contact changes for owners and admins, not managers.
  if (rest.billingContact !== undefined && !(isManager && !isOwner && !user.isAdmin)) {
    update.billingContact = rest.billingContact;
  }
  // Managers can update systemPrompt intentionally - they customize org-wide AI
  // behavior. Authorization is already checked via findUpdateAccessById.
  if (rest.systemPrompt !== undefined) update.systemPrompt = rest.systemPrompt;

  if (user.isAdmin && rest.currentCredits !== undefined) {
    update.currentCredits = rest.currentCredits;
  }

  // Only admins can set per-member credit caps. Coalesce a cleared cap to null, NOT undefined:
  // $set persists null (read as "no cap" by isMemberCreditCapExceeded), and BSON drops
  // undefined, so `?? undefined` would leave the previous cap in place (a null PUT no-ops).
  if (user.isAdmin && rest.maxCreditsPerMember !== undefined) {
    update.maxCreditsPerMember = rest.maxCreditsPerMember ?? null;
  }

  const updated = await adapters.db.organizations.update(update);

  return updated ?? ({ ...plain, ...update } as typeof plain);
};

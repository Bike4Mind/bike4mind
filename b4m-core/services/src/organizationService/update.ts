import {
  ForbiddenError,
  hasOrgPermission,
  IOrganizationRepository,
  IUserDocument,
  MAX_STORAGE_LIMIT_MB,
  OrganizationSharingPolicySchema,
  isOrgMember,
} from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';

const updateSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  billingContact: z.string().optional(),
  systemPrompt: z.string().max(10000).optional(), // ~2500 tokens
  redactPushContent: z.boolean().optional(),
  sharingPolicy: OrganizationSharingPolicySchema.optional(),
  maxCreditsPerMember: z.number().int().positive().nullable().optional(),
  /** Decimal MB; null clears the override back to the plan or default. */
  storageLimit: z.number().min(0).max(MAX_STORAGE_LIMIT_MB).nullable().optional(),
});

type UpdateParameters = z.infer<typeof updateSchema>;

interface UpdateAdapters {
  db: {
    organizations: IOrganizationRepository;
  };
}

export const update = async (user: IUserDocument, params: UpdateParameters, adapters: UpdateAdapters) => {
  const { id, ...rest } = secureParameters(params, updateSchema);

  const organization = await adapters.db.organizations.findById(id);
  if (!organization) throw new NotFoundError('Organization not found');

  // Spreading a hydrated doc nests the real fields under `_doc`, which defeats toSafeOrganization's strip.
  const plain = (
    typeof (organization as { toJSON?: unknown }).toJSON === 'function'
      ? (organization as unknown as { toJSON: () => NonNullable<typeof organization> }).toJSON()
      : organization
  ) as NonNullable<typeof organization>;

  // Every field here is org-wide, so the gate is the team role, never a sharing-ACL row.
  if (!hasOrgPermission(user, plain, 'managePolicies')) {
    if (!isOrgMember(user, plain)) throw new NotFoundError('Organization not found');
    throw new ForbiddenError('Only organization owners and managers can change organization settings.');
  }

  // Persist ONLY the caller-editable fields this request changed, never a spread of
  // the read snapshot. A whole-document write reverted concurrent credit, seat and
  // membership writes; currentCredits/seats/users[]/userDetails[] are never round-tripped.
  const update: Partial<typeof plain> & { id: string } = { id };
  if (rest.name !== undefined) update.name = rest.name;
  if (rest.description !== undefined) update.description = rest.description;
  if (rest.billingContact !== undefined && hasOrgPermission(user, plain, 'manageBilling')) {
    update.billingContact = rest.billingContact;
  }
  if (rest.systemPrompt !== undefined) update.systemPrompt = rest.systemPrompt;
  if (rest.redactPushContent !== undefined) update.redactPushContent = rest.redactPushContent;
  if (rest.sharingPolicy !== undefined) update.sharingPolicy = rest.sharingPolicy;

  // Platform-admin path only. Owners and managers set the default through
  // memberCreditBudget.setMemberCreditDefault (PUT /api/organizations/:id/member-credit-budget).
  // Coalesce a cleared cap to null, NOT undefined:
  // $set persists null (read as "no cap" by isMemberCreditCapExceeded), and BSON drops
  // undefined, so `?? undefined` would leave the previous cap in place (a null PUT no-ops).
  if (user.isAdmin && rest.maxCreditsPerMember !== undefined) {
    update.maxCreditsPerMember = rest.maxCreditsPerMember ?? null;
  }

  const updated = await adapters.db.organizations.update(update);

  // Platform admin only, so a manager cannot raise their own org's quota. Lowering below usage deletes
  // nothing; uploads are just refused.
  if (user.isAdmin && rest.storageLimit !== undefined) {
    const limited = await adapters.db.organizations.setStorageLimitOverride(id, rest.storageLimit);
    if (!limited) throw new NotFoundError('Organization not found');
    return limited;
  }

  return updated ?? ({ ...plain, ...update } as typeof plain);
};

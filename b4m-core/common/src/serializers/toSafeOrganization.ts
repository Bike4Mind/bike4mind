import type { IOrganizationDocument } from '../types/entities/OrganizationTypes';
import { isOrgOwnerOrCurrentAdmin } from '../constants/organization';

/**
 * Response-boundary serializer for organization documents.
 *
 * SECURITY: sanitize at the response boundary, never at the model layer. BaseModel
 * repo methods return the raw doc and internal readers (billing flows, Stripe sync,
 * credit accounting) need the full record, so a model-level strip would break them.
 * Every handler that returns an organization to a client MUST route it through here.
 *
 * What it does (kept deliberately minimal to avoid regressing in-org features):
 * - `stripeCustomerId` is dropped for EVERY caller -- no client consumer reads it;
 *   server-side billing uses the repository directly.
 * - `billingContact` is kept only for the org OWNER or a site admin.
 * - Per-member credit fields in `userDetails` are kept for owners, current managers and site
 *   admins; other viewers keep only their own row's credit fields.
 * - Everything else (name/description/seats/systemPrompt/userDetails identity/currentCredits/
 *   model config/logo) is preserved: the single-org GET is access-gated to members
 *   and roster administrators, and the list routes scope non-admins to their own
 *   memberships or manager appointments, so those fields never cross a tenant boundary.
 *
 * Callers pass a hydrated Mongoose doc (normalized via toJSON here) or a plain object.
 */

export const ORGANIZATION_SECRET_FIELDS = [
  'stripeCustomerId',
  'signupGrantUnlockCount',
  'signupInviteBonusCount',
] as const;
export const ORGANIZATION_OWNER_ONLY_FIELDS = ['billingContact'] as const;
/** Per-member credit paths withheld from everyone but owners, current managers and site admins. */
export const ORGANIZATION_MEMBER_CREDIT_FIELDS = [
  'userDetails.usedCredits',
  'userDetails.maxCredits',
  'userDetails.lastCreditUsedAt',
  'userDetails.periodStart',
] as const;

export type OrgViewer = { userId?: string | null; isAdmin?: boolean | null };

type OrgLike = (Partial<IOrganizationDocument> & { _id?: unknown; toJSON?: () => unknown }) | null | undefined;

export function toSafeOrganization(org: OrgLike, viewer: OrgViewer): Record<string, unknown> | null {
  if (!org) return null;
  // Match what Express would serialize (toJSON runs virtuals/id), then strip.
  const plain: Partial<IOrganizationDocument> =
    typeof (org as { toJSON?: unknown }).toJSON === 'function'
      ? (org as { toJSON: () => Partial<IOrganizationDocument> }).toJSON()
      : (org as Partial<IOrganizationDocument>);
  const o: Record<string, unknown> = { ...plain };

  for (const f of ORGANIZATION_SECRET_FIELDS) delete o[f];

  const isOwner = viewer?.userId != null && plain.userId === viewer.userId;
  const privileged = isOwner || !!viewer?.isAdmin;
  if (!privileged) {
    delete o.billingContact;
  }
  const canViewMemberCredits =
    !!viewer?.isAdmin ||
    (viewer?.userId != null &&
      plain.userId != null &&
      isOrgOwnerOrCurrentAdmin(
        { id: viewer.userId },
        { userId: plain.userId, adminUserIds: plain.adminUserIds, users: plain.users }
      ));
  if (!canViewMemberCredits && Array.isArray(o.userDetails)) {
    o.userDetails = o.userDetails.map(details => {
      // A member keeps their own row: the budget warning reads it from this response.
      if (viewer?.userId != null && String(details.id) === viewer.userId) return details;
      const row = { ...details };
      for (const path of ORGANIZATION_MEMBER_CREDIT_FIELDS) delete row[path.slice('userDetails.'.length)];
      return row;
    });
  }

  return o;
}

/** Array convenience; drops null/undefined entries. */
export function toSafeOrganizations(orgs: OrgLike[] | null | undefined, viewer: OrgViewer): Record<string, unknown>[] {
  return (orgs ?? []).map(o => toSafeOrganization(o, viewer)).filter((o): o is Record<string, unknown> => o !== null);
}

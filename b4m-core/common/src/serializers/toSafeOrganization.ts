import type { IOrganization } from '../types/entities/OrganizationTypes';

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
 * - Everything else (name/description/seats/systemPrompt/userDetails/currentCredits/
 *   model config/logo) is preserved: the single-org GET is already access-gated to
 *   org members, and the list route scopes non-admins to their own orgs, so those
 *   fields never cross a tenant boundary.
 *
 * Callers pass a hydrated Mongoose doc (normalized via toJSON here) or a plain object.
 */

export const ORGANIZATION_SECRET_FIELDS = ['stripeCustomerId'] as const;
export const ORGANIZATION_OWNER_ONLY_FIELDS = ['billingContact'] as const;

export type OrgViewer = { userId?: string | null; isAdmin?: boolean | null };

type OrgLike = (Partial<IOrganization> & { _id?: unknown; toJSON?: () => unknown }) | null | undefined;

export function toSafeOrganization(org: OrgLike, viewer: OrgViewer): Record<string, unknown> | null {
  if (!org) return null;
  // Match what Express would serialize (toJSON runs virtuals/id), then strip.
  const plain: Partial<IOrganization> =
    typeof (org as { toJSON?: unknown }).toJSON === 'function'
      ? (org as { toJSON: () => Partial<IOrganization> }).toJSON()
      : (org as Partial<IOrganization>);
  const o: Record<string, unknown> = { ...plain };

  for (const f of ORGANIZATION_SECRET_FIELDS) delete o[f];

  const isOwner = viewer?.userId != null && plain.userId === viewer.userId;
  const privileged = isOwner || !!viewer?.isAdmin;
  if (!privileged) {
    for (const f of ORGANIZATION_OWNER_ONLY_FIELDS) delete o[f];
  }

  return o;
}

/** Array convenience; drops null/undefined entries. */
export function toSafeOrganizations(orgs: OrgLike[] | null | undefined, viewer: OrgViewer): Record<string, unknown>[] {
  return (orgs ?? []).map(o => toSafeOrganization(o, viewer)).filter((o): o is Record<string, unknown> => o !== null);
}

import type { IOrganizationDocument } from '../types/entities/OrganizationTypes';
import { canAdministerOrganization, canViewOrgMemberCredits } from '../constants/organization';
import { orgMemberHasPermission } from '../constants/orgRoles';
import { Permission } from '../types/entities/ShareableDocumentTypes';

/**
 * Response-boundary serializer for organization documents.
 *
 * SECURITY: sanitize at the response boundary, never at the model layer. BaseModel
 * repo methods return the raw doc and internal readers (billing flows, Stripe sync,
 * credit accounting) need the full record, so a model-level strip would break them.
 * Every handler that returns an organization to a client MUST route it through here.
 *
 * Shape by viewer:
 * - Everyone loses ORGANIZATION_SECRET_FIELDS.
 * - Owners, current managers (`canAdministerOrganization`) and site admins get every other field,
 *   minus what the two rules below withhold.
 * - A member whose `users[]` row holds `update` may edit the team profile (canEditOrgProfile in
 *   the client's orgTabAccess.ts), so they also get the settings fields.
 * - Any other viewer gets only ORGANIZATION_MEMBER_VISIBLE_FIELDS, plus whatever the two rules
 *   below grant them.
 * - `billingContact` goes only to a viewer whose role holds `manageBilling`, or a site admin.
 * - `budgetAlerts` and colleagues' credit fields go only to viewers `canViewOrgMemberCredits`
 *   admits (managePolicies or viewUsage, or a site admin); everyone keeps their own row's.
 *
 * The websocket data-subscribe projection (apps/client/server/websocket/dataSubscribeFieldLimits.ts)
 * excludes ORGANIZATION_ADMINISTRATOR_ONLY_FIELDS for every subscriber who is not the owner, a
 * manager or a site admin; keep the lists and that projection in sync.
 *
 * Callers pass a hydrated Mongoose doc (normalized via toJSON here) or a plain object.
 */

export const ORGANIZATION_SECRET_FIELDS = [
  'stripeCustomerId',
  'signupGrantUnlockCount',
  'signupInviteBonusCount',
] as const;
/** Withheld over REST from everyone without `manageBilling` (owner, billing managers) or platform admin. */
export const ORGANIZATION_OWNER_ONLY_FIELDS = ['billingContact'] as const;
/** Per-member credit paths withheld from everyone `canViewOrgMemberCredits` refuses. */
export const ORGANIZATION_MEMBER_CREDIT_FIELDS = [
  'userDetails.usedCredits',
  'userDetails.maxCredits',
  'userDetails.lastCreditUsedAt',
  'userDetails.periodStart',
] as const;

type OrganizationField = keyof IOrganizationDocument;

/**
 * What a plain member receives. The client computes role and membership checks from `userId`,
 * `adminUserIds`, `billingManagerUserIds` and `users`, so those stay; the rest backs the Overview, Members tab,
 * account switcher and the member's own budget notice.
 */
export const ORGANIZATION_MEMBER_VISIBLE_FIELDS = [
  'id',
  'createdAt',
  'updatedAt',
  'name',
  'description',
  'personal',
  'logo',
  'logoFileId',
  'userId',
  'users',
  'adminUserIds',
  'billingManagerUserIds',
  'userDetails',
  'seats',
  'currentCredits',
  'maxCreditsPerMember',
  'mfaPolicy',
  'retentionPolicy',
] as const satisfies readonly OrganizationField[];

/** Withheld from plain members; the websocket projection excludes these by name. */
export const ORGANIZATION_ADMINISTRATOR_ONLY_FIELDS = [
  'allowedGroupTypes',
  'systemPrompt',
  'storageLimit',
  'currentStorageSize',
  'serviceAccountUserId',
  'redactPushContent',
  'sharingPolicy',
  'budgetAlerts',
  'retentionVersion',
  'lastCreditsPurchasedAt',
  'preferredModel',
  'preferredImageModel',
  'temperature',
  'maxTokens',
  'isGlobalRead',
  'isGlobalWrite',
  'groups',
] as const satisfies readonly OrganizationField[];

// Fails to compile when an organization field is added without deciding who may read it.
type UnclassifiedOrganizationField = Exclude<
  OrganizationField,
  | (typeof ORGANIZATION_MEMBER_VISIBLE_FIELDS)[number]
  | (typeof ORGANIZATION_ADMINISTRATOR_ONLY_FIELDS)[number]
  | (typeof ORGANIZATION_SECRET_FIELDS)[number]
  | (typeof ORGANIZATION_OWNER_ONLY_FIELDS)[number]
>;
const organizationFieldsAreClassified: [UnclassifiedOrganizationField] extends [never] ? true : never = true;
void organizationFieldsAreClassified;

const MEMBER_VISIBLE_FIELD_SET: ReadonlySet<string> = new Set([...ORGANIZATION_MEMBER_VISIBLE_FIELDS, '_id']);

export type OrgViewer = { userId?: string | null; isAdmin?: boolean | null };

type OrgLike = (Partial<IOrganizationDocument> & { _id?: unknown; toJSON?: () => unknown }) | null | undefined;

export function toSafeOrganization(org: OrgLike, viewer: OrgViewer): Record<string, unknown> | null {
  if (!org) return null;
  // Match what Express would serialize (toJSON runs virtuals/id), then strip.
  const plain: Partial<IOrganizationDocument> =
    typeof (org as { toJSON?: unknown }).toJSON === 'function'
      ? (org as { toJSON: () => Partial<IOrganizationDocument> }).toJSON()
      : (org as Partial<IOrganizationDocument>);
  const isSiteAdmin = !!viewer?.isAdmin;
  const actor = viewer?.userId != null ? { id: viewer.userId, isAdmin: isSiteAdmin } : null;
  const roles =
    plain.userId != null
      ? {
          userId: plain.userId,
          adminUserIds: plain.adminUserIds,
          billingManagerUserIds: plain.billingManagerUserIds,
          users: plain.users,
        }
      : null;
  const administers = isSiteAdmin || (actor !== null && roles !== null && canAdministerOrganization(actor, roles));
  const canViewBillingContact =
    isSiteAdmin || (actor !== null && roles !== null && orgMemberHasPermission(roles, actor.id, 'manageBilling'));
  const canViewMemberCredits =
    isSiteAdmin || (actor !== null && roles !== null && canViewOrgMemberCredits(actor, roles));

  const editsProfile =
    actor !== null &&
    (plain.users ?? []).some(row => row.userId === actor.id && row.permissions?.includes(Permission.update));

  const o: Record<string, unknown> =
    administers || editsProfile
      ? { ...plain }
      : Object.fromEntries(
          Object.entries(plain).filter(
            ([field]) =>
              MEMBER_VISIBLE_FIELD_SET.has(field) ||
              (field === 'billingContact' && canViewBillingContact) ||
              (field === 'budgetAlerts' && canViewMemberCredits)
          )
        );

  for (const f of ORGANIZATION_SECRET_FIELDS) delete o[f];
  if (!canViewBillingContact) {
    for (const f of ORGANIZATION_OWNER_ONLY_FIELDS) delete o[f];
  }
  if (!canViewMemberCredits) delete o.budgetAlerts;
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

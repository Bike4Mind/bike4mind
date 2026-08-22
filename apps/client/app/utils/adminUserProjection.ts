import type { IMFAConfig, IOrganizationDocument, IUserDocument } from '@bike4mind/common';

// Both the GET /api/users projection and the client row type (AdminUserListItem) derive from
// this list, so reading a field the endpoint does not emit is a compile error. Shared here
// rather than in the route so pages/api/users/index.ts and the client agree by construction.
//
// The projection is an inclusion allowlist, so a newly-added secret field on the User
// schema can never silently appear here. Aggregation ignores Mongoose select:false, so
// this projection is the only guard. MFA is narrowed to enrollment status -- totpSecret /
// backupCodes must never reach the client, even an admin's browser. (The joined
// `organization` object is admin-scoped org data; its own field-level exposure is tracked
// separately, not here.)
export const ADMIN_USER_LIST_FIELDS = [
  'name',
  'username',
  'email',
  'isAdmin',
  'level',
  'tags',
  'isBanned',
  'isModerated',
  'photoUrl',
  'phone',
  'role',
  'team',
  'isOnline',
  'preferences',
  'storageLimit',
  'currentStorageSize',
  'createdAt',
  'updatedAt',
  'lastActiveAt',
  // loginRecords is admin-only PII (IPs/userAgents): it is in USER_SECRET_FIELDS so the
  // toSafeUser/redactUserSecretsForSelf serializers drop it, but the admin activity view
  // reads it here. Intentional admin-only exposure, not a serialize-everywhere field.
  'loginRecords',
  'subscribedUntil',
  'numReferralsAvailable',
  'currentCredits',
  'organizationId',
  'pendingEmail',
  'emailVerified',
] as const satisfies readonly (keyof IUserDocument)[];

export const ADMIN_USER_PROJECTION: Record<string, 1> = {
  _id: 1,
  ...Object.fromEntries(ADMIN_USER_LIST_FIELDS.map(field => [field, 1])),
  'mfa.totpEnabled': 1,
  'mfa.setupAt': 1,
  'mfa.lastUsedAt': 1,
  organization: 1,
};

// Deliberately a structural subset of IUserDocument (no `_id`) so the wider single-user
// response, WithOrgRef<IUserDocument> from GET /api/users/[id], is assignable to it -- the
// admin user views render rows from either endpoint.
export type AdminUserListItem = Omit<Pick<IUserDocument, (typeof ADMIN_USER_LIST_FIELDS)[number]>, 'organizationId'> & {
  // Rows are returned through User.hydrate(), so JSON carries the `id` virtual.
  id: string;
  // The endpoint populates organizationId, so it arrives as the org document (null when unset).
  organizationId: IOrganizationDocument | null;
  mfa?: Pick<IMFAConfig, 'totpEnabled' | 'setupAt' | 'lastUsedAt'> | null;
  // Joined by the $lookup stage, absent when the user has no organization.
  organization?: IOrganizationDocument;
};

export const PUBLIC_USER_LIST_PROJECTION: Record<string, 1> = { _id: 1, username: 1, name: 1, email: 1 };

import * as z from 'zod';
import { passthroughShape } from '@bike4mind/common';
import { ADMIN_USER_LIST_FIELDS } from '@client/app/utils/adminUserProjection';

const ADMIN_USER_ROW_KEYS = Object.fromEntries([...ADMIN_USER_LIST_FIELDS, 'id'].map(field => [field, true])) as Record<
  (typeof ADMIN_USER_LIST_FIELDS)[number] | 'id',
  true
>;

// Key boundary only, built from the same list as the GET /api/users projection: a field the
// projection does not return is not declared here, so the rows hydrate() pads with schema defaults
// (passwordHash, isSystem, ...) are stripped rather than shipped as if they were the user's own data.
// `organizationId` already left through withSafeOrganization; `mfa` is narrowed to enrollment status.
const adminUserRowSchema = z.object({
  ...passthroughShape(ADMIN_USER_ROW_KEYS),
  mfa: z
    .object(passthroughShape({ totpEnabled: true, setupAt: true, lastUsedAt: true }))
    .nullable()
    .optional(),
  pendingInvite: z.boolean().optional(),
});

/** GET /api/users, paginated admin / public-view listing. */
export const adminUserListResponseSchema = z.object({
  users: z.array(adminUserRowSchema),
  currentPage: z.number(),
  totalPages: z.number(),
  totalUsers: z.number(),
});

/** GET /api/users?downloadAll=true. */
export const adminUserDownloadResponseSchema = z.object({
  users: z.array(adminUserRowSchema),
  totalUsers: z.number(),
});

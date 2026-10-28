import { userRepository } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import type { AdminUserRef } from './schemas';

/**
 * The only user fields the admin assistant may emit. Mirrors the non-secret subset of
 * ADMIN_USER_LIST_FIELDS (apps/client/app/utils/adminUserProjection.ts); `lastActiveAt` is the
 * schema's last-seen timestamp. Output is always built by picking these, never by spreading a doc.
 */
export const ADMIN_ASSISTANT_USER_FIELDS = [
  'id',
  'name',
  'username',
  'email',
  'createdAt',
  'lastActiveAt',
  'isAdmin',
  'emailVerified',
  'currentCredits',
  'apiKeyTrustApproved',
  'organizationId',
] as const;

/** Never `findByUsernameOrEmail`: it selects `+password`. findByEmail matches case-insensitively via collation. */
export async function resolveAdminUserRef(ref: AdminUserRef): Promise<IUserDocument | null> {
  if (ref.userId !== undefined) return userRepository.findById(ref.userId);
  if (ref.email !== undefined) return userRepository.findByEmail(ref.email.trim());
  return null;
}

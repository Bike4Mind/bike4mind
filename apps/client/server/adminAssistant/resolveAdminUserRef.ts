import { userRepository } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import { presentRef, type AdminUserRef } from './schemas';

/** Never `findByUsernameOrEmail`: it selects `+password`. findByEmail matches case-insensitively via collation. */
export async function resolveAdminUserRef(ref: AdminUserRef): Promise<IUserDocument | null> {
  const userId = presentRef(ref.userId);
  if (userId !== undefined) return userRepository.findById(userId);
  const email = presentRef(ref.email);
  if (email !== undefined) return userRepository.findByEmail(email);
  return null;
}

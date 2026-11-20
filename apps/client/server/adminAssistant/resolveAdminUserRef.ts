import { userRepository } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import type { AdminUserRef } from './schemas';

/** Never `findByUsernameOrEmail`: it selects `+password`. findByEmail matches case-insensitively via collation. */
export async function resolveAdminUserRef(ref: AdminUserRef): Promise<IUserDocument | null> {
  if (ref.userId !== undefined) return userRepository.findById(ref.userId);
  if (ref.email !== undefined) return userRepository.findByEmail(ref.email);
  return null;
}

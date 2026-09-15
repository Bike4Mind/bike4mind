import { IUserDocument, IUserRepository } from '@bike4mind/common';

export interface ForceResetMFARequest {
  targetUserId: string;
  adminUser: IUserDocument;
}

export interface ForceResetMFAResponse {
  success: boolean;
  user: IUserDocument;
}

/**
 * Force reset MFA for a user (admin only)
 * This completely removes MFA configuration, allowing the user to set it up again
 */
export async function forceResetMFA(
  { targetUserId, adminUser }: ForceResetMFARequest,
  userRepository: Pick<IUserRepository, 'findById' | 'update'>
): Promise<ForceResetMFAResponse> {
  if (!adminUser.isAdmin) {
    throw new Error('Only administrators can force reset MFA.');
  }

  const targetUser = await userRepository.findById(targetUserId);
  if (!targetUser) {
    throw new Error('Target user not found.');
  }

  if (!targetUser.mfa || !targetUser.mfa.totpEnabled) {
    throw new Error('Target user does not have MFA enabled.');
  }

  const updatedUser = await userRepository.update({ id: targetUserId, mfa: null, updatedAt: new Date() });

  if (!updatedUser) {
    throw new Error('Failed to reset MFA for target user.');
  }

  return {
    success: true,
    user: updatedUser,
  };
}

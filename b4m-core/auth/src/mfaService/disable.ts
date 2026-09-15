import { IUserDocument, IUserRepository } from '@bike4mind/common';
import { userCanDisableMFA } from './utils';

export interface DisableMFARequest {
  user: IUserDocument;
  enforceMFA: boolean;
}

export interface DisableMFAResponse {
  success: boolean;
  user: IUserDocument;
}

/**
 * Disable MFA for a user
 * Checks enforcement settings to determine if the user can disable MFA
 */
export async function disableMFA(
  { user, enforceMFA }: DisableMFARequest,
  userRepository: Pick<IUserRepository, 'update'>
): Promise<DisableMFAResponse> {
  if (!user.mfa || !user.mfa.totpEnabled) {
    throw new Error('MFA is not enabled for this user.');
  }

  if (!userCanDisableMFA(user, enforceMFA)) {
    throw new Error('MFA cannot be disabled due to enforcement policy.');
  }

  const updatedUser = await userRepository.update({
    id: user.id,
    mfa: null,
    updatedAt: new Date(),
  });

  if (!updatedUser) {
    throw new Error('Failed to disable MFA.');
  }

  return {
    success: true,
    user: updatedUser,
  };
}

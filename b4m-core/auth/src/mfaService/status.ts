import { IUserDocument } from '@bike4mind/common';
import { userHasMFAConfigured, userRequiresMFA, userCanDisableMFA } from './utils';

export interface MFAStatusRequest {
  user: IUserDocument;
  enforceMFA: boolean;
}

export interface MFAStatusResponse {
  enabled: boolean;
  required: boolean;
  canDisable: boolean;
  setupAt?: Date;
  lastUsedAt?: Date;
  backupCodesCount: number;
}

/**
 * Get MFA status for a user
 */
export function getMFAStatus({ user, enforceMFA }: MFAStatusRequest): MFAStatusResponse {
  const enabled = userHasMFAConfigured(user);
  const required = userRequiresMFA(user, enforceMFA);
  const canDisable = userCanDisableMFA(user, enforceMFA);

  return {
    enabled,
    required,
    canDisable,
    setupAt: user.mfa?.setupAt,
    lastUsedAt: user.mfa?.lastUsedAt,
    backupCodesCount: user.mfa?.backupCodes?.length || 0,
  };
}

import type { IUser } from './types/entities/UserTypes';

/**
 * True when this account is held to MFA enforcement on its own (IUser.mfaEnforcement), whatever the
 * stage setting says. Every reader of the setting ORs this in: userRequiresMFA and userCanDisableMFA
 * (auth mfaService/utils.ts), isMfaEnrollmentOwed (server-utils auth/mfaEnforcement.ts),
 * resolveSecondFactor and the enrollment funnel (apps/client server/auth). The exemptions still win.
 */
export function isMfaForcedForUser(user: Pick<IUser, 'mfaEnforcement'>): boolean {
  return user.mfaEnforcement === 'force';
}

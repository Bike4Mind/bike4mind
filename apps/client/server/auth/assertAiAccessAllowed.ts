import { AI_ACCESS_REVOKED_MESSAGE, isAiAccessRevoked } from '@bike4mind/services/userService/accountState';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';

/**
 * The route-level gate for the admin "Moderate" action: AI features only, never sign-in (that is
 * `assertAccountStateUsable`). Text-LLM paths are gated in `createModelAdmission` instead; this
 * covers the media, voice and credit-reserving routes that never reach model admission.
 */
export function assertAiAccessAllowed(user: Parameters<typeof isAiAccessRevoked>[0] | undefined): void {
  if (!user) throw new UnauthorizedError('User not found');
  if (isAiAccessRevoked(user)) throw new ForbiddenError(AI_ACCESS_REVOKED_MESSAGE);
}

import { aiAccessDeniedMessage, type AiAccessStateFields } from '@bike4mind/services/userService/accountState';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';

/**
 * The route-level gate for manual restrictions and signup review holds: AI only, never sign-in (that is
 * `assertAccountStateUsable`). Text-LLM paths are gated in `createModelAdmission` instead; this
 * covers the media, voice and credit-reserving routes that never reach model admission.
 */
export function assertAiAccessAllowed(user: AiAccessStateFields | undefined): void {
  if (!user) throw new UnauthorizedError('User not found');
  const message = aiAccessDeniedMessage(user);
  if (message) throw new ForbiddenError(message);
}

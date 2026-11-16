import { envKey, EXPIRED_API_KEY } from '@bike4mind/auth/apiKeyService';

/**
 * The OpenAI key for the prompt moderation check. Moderation enforces platform policy, so the shared
 * admin key (or the self-host env key) comes first. A user's own key that has expired, been revoked
 * or run out of quota would otherwise fail the check, and since the check fails closed, block every
 * prompt that user sends whatever model they chat with. Returns null when there is no usable key, so
 * the caller can fall through to its keyless path.
 *
 * Callers: ChatCompletionProcess (chat prompt), ImageGeneration and ImageEdit (image prompts).
 */
export const resolveModerationOpenaiKey = (
  effectiveOpenaiKey: string | null | undefined,
  sharedOpenaiKey: string | null | undefined
): string | null => {
  const platformKey = sharedOpenaiKey || envKey('OPENAI_API_KEY');
  if (platformKey) return platformKey;
  if (!effectiveOpenaiKey || effectiveOpenaiKey === EXPIRED_API_KEY) return null;
  return effectiveOpenaiKey;
};

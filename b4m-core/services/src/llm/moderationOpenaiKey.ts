import { envKey } from '@bike4mind/auth/apiKeyService';
import { usableDecisionApiKey } from './decisionProviders';

/**
 * The OpenAI key for the prompt moderation check. Moderation enforces platform policy, so the shared
 * admin key (or the self-host env key) comes first. A user's own key that has expired, been revoked
 * or run out of quota would otherwise fail the check, and since the check fails closed, block every
 * prompt that user sends whatever model they chat with. Placeholder keys (e.g. an unfilled
 * `.env.example` value) count as absent too. Returns null when there is no usable key, so
 * the caller can fall through to its keyless path.
 *
 * Callers: ChatCompletionProcess (chat prompt), ImageGeneration and ImageEdit (image prompts).
 */
export const resolveModerationOpenaiKey = (
  effectiveOpenaiKey: string | null | undefined,
  sharedOpenaiKey: string | null | undefined
): string | null => {
  return (
    usableDecisionApiKey(sharedOpenaiKey) ??
    usableDecisionApiKey(envKey('OPENAI_API_KEY')) ??
    usableDecisionApiKey(effectiveOpenaiKey)
  );
};

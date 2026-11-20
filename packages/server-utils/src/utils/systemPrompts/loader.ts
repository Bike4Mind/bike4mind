import { systemPromptRepository } from '@bike4mind/database';
import { getDefaultSystemPrompts } from './defaults';

/**
 * Marker prefix for admin-loaded system prompts injected via extraContextMessages.
 * ChatCompletionProcess checks for this to skip hardcoded fallbacks.
 */
export const ADMIN_PROMPT_MARKER = '[ADMIN_PROMPT:';

/**
 * Load system prompt content from admin DB, falling back to code defaults.
 *
 * Resolution order:
 *   1. DB record exists with activeVersion > 0 -> use DB content
 *   2. DB record exists with activeVersion = 0 -> use code default
 *   3. No DB record -> use code default
 *   4. Prompt disabled -> returns null
 *
 * `codeDefault` lets a caller supply its own fallback content instead of the shared
 * defaults registry - product surfaces whose prompt content must not ship in open core
 * keep the content in their own (removable) namespace and pass it here explicitly.
 *
 * Returns content WITH the admin marker prefix for injection via extraContextMessages.
 */
export async function loadSystemPromptContent(
  promptId: string,
  codeDefaultOverride?: { content: string }
): Promise<{ content: string; source: 'db' | 'code' } | null> {
  const codeDefault = codeDefaultOverride ?? getDefaultSystemPrompts().find(p => p.promptId === promptId);

  // Check if prompt is disabled in DB
  const dbPrompt = await systemPromptRepository.findByPromptId(promptId);
  if (dbPrompt && !dbPrompt.enabled) {
    return null; // Admin has disabled this prompt
  }

  // Resolve content via getActiveContent (handles version resolution)
  const content = await systemPromptRepository.getActiveContent(
    promptId,
    codeDefault ? { content: codeDefault.content } : undefined
  );

  if (content) {
    return { content, source: dbPrompt ? 'db' : 'code' };
  }

  // Final fallback to code default
  if (codeDefault) {
    return { content: codeDefault.content, source: 'code' };
  }

  return null;
}

/**
 * Build an extraContextMessage from a loaded system prompt.
 * Prepends the admin marker so ChatCompletionProcess can detect
 * that the prompt was already provided and skip hardcoded fallbacks.
 */
export function buildSystemPromptMessage(promptId: string, content: string) {
  return {
    role: 'system' as const,
    content: `${ADMIN_PROMPT_MARKER}${promptId}]\n${content}`,
  };
}

/**
 * Load the base Bike4Mind identity prompt for general chat as an
 * `extraContextMessages` entry. Gives the assistant a sense of what Bike4Mind is and why it
 * exists so it can pitch the product when asked. Falls back to the code default; returns an
 * empty array if an admin has disabled the prompt (so it stays admin-controllable).
 */
// General chat is a hot path and the identity prompt changes only on admin edit, so cache the
// built messages in-process with a short TTL. This removes two Mongo lookups (findByPromptId +
// getActiveContent) from the typical per-turn path; an admin edit takes effect within the TTL.
// Per-Lambda-container and best-effort - correctness never depends on the cache.
let identityPromptCache: { messages: { role: 'system'; content: string }[]; expiresAt: number } | null = null;
const IDENTITY_PROMPT_CACHE_TTL_MS = 60_000;

export async function loadBaseIdentitySystemPromptMessages(logger?: {
  debug: (msg: string) => void;
}): Promise<{ role: 'system'; content: string }[]> {
  const now = Date.now();
  if (identityPromptCache && identityPromptCache.expiresAt > now) {
    return identityPromptCache.messages;
  }
  const identity = await loadSystemPromptContent('bike4mind_identity');
  const messages = identity ? [buildSystemPromptMessage('bike4mind_identity', identity.content)] : [];
  identityPromptCache = { messages, expiresAt: now + IDENTITY_PROMPT_CACHE_TTL_MS };
  if (identity) logger?.debug(`📋 Loaded bike4mind_identity prompt (source: ${identity.source})`);
  return messages;
}

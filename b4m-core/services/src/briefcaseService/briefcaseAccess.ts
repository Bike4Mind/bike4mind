import type { ICaller, IBriefcasePromptDocument } from '@bike4mind/common';
import { UnauthorizedError } from '@bike4mind/common';

/**
 * The briefcase access contract. Three decisions read as one:
 *  - read gate: any authenticated caller may read the catalog
 *  - personal scoping: owner-bound by the repository (never client id), and never
 *    to an API key (canSeePersonalPrompts)
 *  - visibility scoping: this file - system prompts gated by the caller's tags
 */

/** Admin bypass is for INTERACTIVE admins only - an API key never inherits it. */
function isPrivileged(caller: ICaller): boolean {
  return caller.isAdmin && !caller.isApiKey;
}

/**
 * Whether a system prompt is visible to the caller. Empty/absent
 * `visibilityScopes` => visible to all. Otherwise the caller must hold at least
 * one matching entitlement (case-insensitive). Privileged admins bypass.
 */
export function canSeeSystemPrompt(
  prompt: Pick<IBriefcasePromptDocument, 'visibilityScopes'>,
  caller: ICaller
): boolean {
  if (isPrivileged(caller)) return true;
  const scopes = prompt.visibilityScopes;
  if (!scopes || scopes.length === 0) return true;
  const held = new Set(caller.entitlements.map(e => e.toLowerCase()));
  return scopes.some(s => held.has(s.toLowerCase()));
}

/**
 * Whether the caller may see personal prompts at all. An API key is a headless
 * integration, not the owning human - handing it the key-user's personal prompts
 * is a confused-deputy exfiltration path.
 */
export function canSeePersonalPrompts(caller: ICaller): boolean {
  return !caller.isApiKey;
}

/**
 * By-id read decision for a prompt the repository already owner-scoped to the
 * caller: system prompts pass the catalog's visibility gate, personal prompts the
 * API-key gate. Keeps the by-id path from bypassing either catalog rule.
 */
export function canReadPrompt(
  prompt: Pick<IBriefcasePromptDocument, 'userId' | 'visibilityScopes'>,
  caller: ICaller
): boolean {
  return prompt.userId == null ? canSeeSystemPrompt(prompt, caller) : canSeePersonalPrompts(caller);
}

/** Filter a system-prompt list to those visible to the caller (admins bypass). */
export function filterByEntitlement(prompts: IBriefcasePromptDocument[], caller: ICaller): IBriefcasePromptDocument[] {
  return prompts.filter(p => canSeeSystemPrompt(p, caller));
}

/** The read gate: rejects an unauthenticated caller. */
export function assertCanReadPrompts(caller: ICaller | undefined): asserts caller is ICaller {
  if (!caller?.id) {
    throw new UnauthorizedError('Authentication required to read the briefcase catalog');
  }
}

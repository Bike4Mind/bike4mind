import type { ICaller, IBriefcasePromptDocument } from '@bike4mind/common';
import type { BriefcaseServiceAdapters } from './ports';

/**
 * Personal prompts for the AUTHENTICATED caller only. Ownership is bound to
 * `caller.id` resolved server-side - a client cannot name another user.
 *
 * API-key callers receive NOTHING here: an API key is a headless integration,
 * not the owning human, and returning the key-user's personal prompts to any
 * key holder is a confused-deputy exfiltration path.
 */
export async function getPersonalPrompts(
  caller: ICaller,
  { db }: BriefcaseServiceAdapters
): Promise<IBriefcasePromptDocument[]> {
  if (caller.isApiKey) return [];
  return db.briefcasePrompts.listPersonal(caller.id);
}

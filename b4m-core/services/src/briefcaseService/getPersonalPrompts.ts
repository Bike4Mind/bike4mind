import type { ICaller, IBriefcasePromptDocument } from '@bike4mind/common';
import type { BriefcaseServiceAdapters } from './ports';
import { canSeePersonalPrompts } from './briefcaseAccess';

/**
 * Personal prompts for the AUTHENTICATED caller only. Ownership is bound to
 * `caller.id` resolved server-side - a client cannot name another user.
 * API-key callers receive NOTHING here (see canSeePersonalPrompts).
 */
export async function getPersonalPrompts(
  caller: ICaller,
  { db }: BriefcaseServiceAdapters
): Promise<IBriefcasePromptDocument[]> {
  if (!canSeePersonalPrompts(caller)) return [];
  return db.briefcasePrompts.listPersonal(caller.id);
}

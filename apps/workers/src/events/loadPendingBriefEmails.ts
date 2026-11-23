import { BRIEF_LIMITS } from '@bike4mind/common';
import { EMAIL_TRIAGE_KINDS, emailTriageItemRepository } from '@bike4mind/database';

/** Pending items survive failed briefs and section caps. */
export async function loadPendingBriefEmails(userId: string, end: Date) {
  const sections = await Promise.all(
    EMAIL_TRIAGE_KINDS.map(kind =>
      emailTriageItemRepository.listPending(userId, end, BRIEF_LIMITS.itemsPerSection, kind)
    )
  );
  return sections.flat();
}

import type { IUserRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

/** Escalation states a user may appeal against. `active` users have nothing to appeal. */
const APPEALABLE_STATUSES = new Set(['throttled', 'suspend_pending', 'suspended']);

/** Max length of a submitted appeal message. */
export const MODERATION_APPEAL_MAX_LENGTH = 2000;

export interface RequestModerationAppealAdapters {
  db: {
    users: Pick<IUserRepository, 'findById' | 'recordModerationAppeal'>;
  };
}

/**
 * Record a user's appeal against their moderation escalation. Only users currently
 * throttled, flagged for suspension, or suspended may appeal; an admin then reviews the appeal
 * text and either lifts the escalation (`setModerationStatus('active')`) or confirms it.
 */
export async function requestModerationAppeal(
  userId: string,
  appealText: string,
  { db }: RequestModerationAppealAdapters
) {
  const trimmed = appealText?.trim();
  if (!trimmed) {
    throw new BadRequestError('An appeal message is required.');
  }
  if (trimmed.length > MODERATION_APPEAL_MAX_LENGTH) {
    throw new BadRequestError(`Appeal message must be ${MODERATION_APPEAL_MAX_LENGTH} characters or fewer.`);
  }

  const user = await db.users.findById(userId);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const status = user.moderation?.status;
  if (!status || !APPEALABLE_STATUSES.has(status)) {
    throw new BadRequestError('There is no active moderation action on your account to appeal.');
  }

  return db.users.recordModerationAppeal(userId, trimmed);
}

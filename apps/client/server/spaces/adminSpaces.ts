import { ForbiddenError, InboxType, isFullAdmin, type ISpaceDocument } from '@bike4mind/common';
import { inboxRepository } from '@bike4mind/database';
import { userRepository } from '@bike4mind/database/auth';
import { Logger } from '@bike4mind/observability';
import { spaceService } from '@bike4mind/services';
import { queuedMailer } from '@bike4mind/server-utils/utils/mailer/queuedMailer';

const defaultLogger = new Logger({ metadata: { service: 'adminSpaces' } });

/**
 * The admin Space routes list every tenant's Spaces with member emails, so they sit behind the same bar as
 * the organization membership routes: a delegated `users:moderate` admin is refused with a plain message.
 */
export const assertFullAdminForSpaces = (user: { isAdmin?: boolean | null } | undefined): void => {
  if (!isFullAdmin(user)) throw new ForbiddenError('Only full administrators can manage Spaces');
};

/** Tells the owner a platform admin deleted their Space. No reason text. Call after the delete commits; never throws. */
export async function notifyOwnerSpaceDeletedByAdmin(
  space: Pick<ISpaceDocument, 'ownerUserId' | 'name'>,
  logger: { warn(msg: string, meta: unknown): void } = defaultLogger
): Promise<void> {
  try {
    await inboxRepository.createInboxMessage({
      type: InboxType.COMMON,
      title: `${space.name} was deleted`,
      message: `A platform administrator deleted your Space ${space.name}.`,
      receiverId: space.ownerUserId,
      userId: 'SYSTEM',
    });
  } catch (error) {
    logger.warn('[spaces] admin delete inbox notice failed', { ownerUserId: space.ownerUserId, error: String(error) });
  }
  await spaceService.notifySpaceDeletedByAdmin(
    { ownerUserId: space.ownerUserId, spaceName: space.name },
    { db: { users: userRepository }, mailer: queuedMailer, logger }
  );
}

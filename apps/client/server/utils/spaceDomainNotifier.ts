import { spaceService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database/auth';
import mailer from '@bike4mind/server-utils/utils/mailer/index';

/** Tell a Space owner the Space lost a domain to an org. Call after the release commits; never throws. */
export async function notifySpaceDomainReleasedByEmail(
  ownerUserId: string,
  spaceName: string,
  domain: string,
  logger?: { warn(msg: string, meta: unknown): void }
): Promise<void> {
  await spaceService.notifySpaceDomainReleased(
    { ownerUserId, spaceName, domain },
    { db: { users: userRepository }, mailer, logger }
  );
}

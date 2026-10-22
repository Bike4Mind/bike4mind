import { userApiKeyService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database/auth';
import mailer from './mailer';

/**
 * Thin wrapper that assembles the db/mailer adapters and calls the service-layer
 * notifier. Call after the rotation commits and only when previousOwnerUserId is set.
 * Never throws into the route handler.
 */
export async function notifyApiKeyRotationReown(
  previousOwnerUserId: string,
  keyName: string,
  logger?: { warn(msg: string, meta: unknown): void }
): Promise<void> {
  await userApiKeyService.notifyApiKeyReowned(
    { previousOwnerUserId, keyName },
    { db: { users: userRepository }, mailer, logger }
  );
}

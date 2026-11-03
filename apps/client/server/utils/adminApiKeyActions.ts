import type { Request } from 'express';
import { BadRequestError, NotFoundError, type AuditTarget, type IUserApiKeyDocument } from '@bike4mind/common';
import { realtimeConnectionRepository, userRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { authSessionService } from '@bike4mind/services';

/** Reads the `[id]` route segment, which is the user API key document id. */
export function readApiKeyIdParam(req: { query: unknown }): string {
  const { id } = req.query as { id?: string | string[] };
  if (typeof id !== 'string' || !id) throw new BadRequestError('Invalid API key ID');
  return id;
}

export async function loadApiKeyOrThrow(keyId: string): Promise<IUserApiKeyDocument> {
  const key = await userApiKeyRepository.findById(keyId);
  if (!key) throw new NotFoundError('API key not found');
  return key;
}

/** Key actions are audited against the key's owner; an orphaned owner falls back to the raw id. */
export async function ownerAuditTarget(ownerUserId: string): Promise<AuditTarget> {
  const owner = await userRepository.findById(ownerUserId);
  return { kind: 'user', id: ownerUserId, displayName: owner?.email ?? owner?.username ?? ownerUserId };
}

/** Identifies a key in audit details: id and public prefix only, never any secret material. */
export const auditKeyRef = (key: Pick<IUserApiKeyDocument, 'id' | 'keyPrefix'>) => ({
  keyId: key.id,
  keyPrefix: key.keyPrefix,
});

/** Drops the sockets a revoked key opened; never throws (the realtime sweep backstops a failure). */
export async function endKeyRealtimeConnections(keyId: string, logger: Request['logger']): Promise<void> {
  await authSessionService.endRealtimeConnections(
    { apiKeyId: keyId },
    { db: { realtimeConnections: realtimeConnectionRepository }, logger }
  );
}

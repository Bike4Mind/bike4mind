import { createHash } from 'node:crypto';
import { ApiKeyScope, Permission } from '@bike4mind/common';
import { SecretRotation, secretRotationRepository } from '@bike4mind/database/infra';
import { BadRequestError, ForbiddenError, InternalServerError, NotFoundError } from '@bike4mind/utils';
import { encryptAtRest, decryptAtRest } from '@bike4mind/utils/security';
import { calculateNextRotationDate, toSafeSecretRotation } from '@client/lib/secretRotation/utils';
import { Config } from '@bike4mind/server-utils/utils/config';
import { SECRET_ROTATION_GRACE_MS } from '@bike4mind/server-utils/auth/secretRotationGrace';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const renewRequestSchema = z.object({
  id: z.string(),
});

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req, res) => {
  if (!req.ability?.can(Permission.update, SecretRotation)) {
    throw new ForbiddenError();
  }

  const { id } = renewRequestSchema.parse(req.body);

  const secret = await secretRotationRepository.findById(id);
  if (!secret) {
    throw new NotFoundError('Secret rotation not found');
  }

  // Snapshot the secret this process is running with, rather than trusting a caller to hand over
  // the outgoing value. JWT_SECRET is the only row whose `previousKey` any verifier reads (see
  // packages/server-utils/src/auth/secretRotationGrace.ts). Runbook: click Renew BEFORE deploying the replacement
  // secret; re-capturing the same value advances the grace window instead of extending a stale
  // key's life, which is why a capture that matches the last one is refused below.
  const currentFingerprint = createHash('sha256').update(Config.JWT_SECRET).digest('hex');
  if (secret.keyName === 'JWT_SECRET') {
    // Retire a previous key whose grace window has closed before it is read. The rotation cron
    // runs only where scheduled jobs are deployed, so this write path is what bounds the retired
    // secret's lifetime on every other stage.
    await secretRotationRepository.expirePreviousKey('JWT_SECRET', SECRET_ROTATION_GRACE_MS);
    const captured = await secretRotationRepository.findByKeyNameWithSecret('JWT_SECRET');
    if (
      captured?.capturedKeyFingerprint === currentFingerprint ||
      (captured?.previousKey && decryptAtRest(captured.previousKey) === Config.JWT_SECRET)
    ) {
      throw new BadRequestError('The signing secret has not changed since its last capture');
    }
  }
  const previousKey = secret.keyName === 'JWT_SECRET' ? encryptAtRest(Config.JWT_SECRET) : undefined;

  try {
    const updated = await secretRotationRepository.update({
      id,
      previousKey,
      ...(secret.keyName === 'JWT_SECRET' ? { capturedKeyFingerprint: currentFingerprint } : {}),
      rotatedAt: new Date(),
      nextRotation: calculateNextRotationDate(secret.rotationIntervalDays),
      lastRotatedById: req.user?.id,
      lastRotatedByName: req.user?.name,
    });

    if (!updated) {
      throw new InternalServerError('Failed to update secret');
    }
    // Never `res.json(updated)`: this handler just wrote the live JWT_SECRET into
    // `previousKey`, and the raw document would carry it to the browser.
    return res.json(toSafeSecretRotation(updated));
  } catch (error) {
    throw new InternalServerError('Failed to update secret', { error });
  }
});

export default handler;

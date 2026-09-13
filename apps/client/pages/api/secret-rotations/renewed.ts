import { ApiKeyScope, Permission } from '@bike4mind/common';
import { SecretRotation, secretRotationRepository } from '@bike4mind/database/infra';
import { ForbiddenError, InternalServerError, NotFoundError } from '@bike4mind/utils';
import { encryptAtRest } from '@bike4mind/utils/security';
import { calculateNextRotationDate, toSafeSecretRotation } from '@client/lib/secretRotation/utils';
import { Config } from '@server/utils/config';
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

  // Snapshot the secret this process is running with, rather than trusting a caller
  // to hand over the outgoing value. JWT_SECRET is the only row whose `previousKey`
  // any verifier reads (see server/auth/secretRotationGrace.ts). Re-capturing on every
  // renew advances the grace window instead of extending a stale key's life, so the
  // runbook is: click Renew BEFORE deploying the replacement secret.
  // Encrypt at rest: this is a live signing secret and must not sit in Mongo as
  // plaintext; the two verifiers that read it (auth.ts, verifyWsAccessToken.ts)
  // decryptAtRest it. Plaintext rows written before this keep working (decrypt passes
  // a non-ciphertext value through unchanged) and re-encrypt on the next renew.
  const previousKey = secret.keyName === 'JWT_SECRET' ? encryptAtRest(Config.JWT_SECRET) : undefined;

  try {
    const updated = await secretRotationRepository.update({
      id,
      previousKey,
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

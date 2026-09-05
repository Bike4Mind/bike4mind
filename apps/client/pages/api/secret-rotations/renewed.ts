import { ApiKeyScope, Permission } from '@bike4mind/common';
import { SecretRotation, secretRotationRepository } from '@bike4mind/database/infra';
import { ForbiddenError, InternalServerError, NotFoundError } from '@bike4mind/utils';
import { calculateNextRotationDate } from '@client/lib/secretRotation/utils';
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
  const previousKey = secret.keyName === 'JWT_SECRET' ? Config.JWT_SECRET : undefined;

  try {
    const updated = await secretRotationRepository.update({
      id,
      previousKey,
      rotatedAt: new Date(),
      nextRotation: calculateNextRotationDate(secret.rotationIntervalDays),
      lastRotatedById: req.user?.id,
      lastRotatedByName: req.user?.name,
    });

    return res.json(updated);
  } catch (error) {
    throw new InternalServerError('Failed to update secret', { error });
  }
});

export default handler;

import { Permission } from '@bike4mind/common';
import { SecretRotation, secretRotationRepository } from '@bike4mind/database/infra';
import { ForbiddenError, InternalServerError, NotFoundError } from '@bike4mind/utils';
import { calculateNextRotationDate } from '@client/lib/secretRotation/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const renewRequestSchema = z.object({
  id: z.string(),
});

const handler = baseApi().post(async (req, res) => {
  if (!req.ability?.can(Permission.update, SecretRotation)) {
    return new ForbiddenError();
  }

  const { id } = renewRequestSchema.parse(req.body);

  const secret = await secretRotationRepository.findById(id);
  if (!secret) {
    return new NotFoundError('Secret rotation not found');
  }

  try {
    const updated = await secretRotationRepository.update({
      id,
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

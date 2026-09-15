import { Permission } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { SecretRotation, secretRotationRepository } from '@bike4mind/database/infra';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

const handler = baseApi()
  .put(async (req, res) => {
    if (!req.ability?.can(Permission.update, SecretRotation)) {
      return new ForbiddenError();
    }

    const schema = z.object({
      id: z.string(),
      previousKey: z.string().optional(),
      rotationIntervalDays: z.number().min(1).max(365).optional(),
      description: z.string().optional(),
    });

    const params = schema.parse(req.body);

    const updated = await secretRotationRepository.update(params);
    return res.json(updated);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

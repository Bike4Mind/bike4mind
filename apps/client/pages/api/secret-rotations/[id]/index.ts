import { ApiKeyScope, Permission } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { SecretRotation, secretRotationRepository } from '@bike4mind/database/infra';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).put(async (req, res) => {
  if (!req.ability?.can(Permission.update, SecretRotation)) {
    throw new ForbiddenError();
  }

  // No `previousKey` here on purpose: a caller-submitted value cannot be shown to
  // have ever been the real secret, and the rotation grace window trusts it to verify
  // tokens. The server captures it itself on renew (see ../renewed.ts).
  const schema = z.object({
    id: z.string(),
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

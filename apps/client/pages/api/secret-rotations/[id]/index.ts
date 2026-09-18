import { ApiKeyScope, Permission } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { SecretRotation, secretRotationRepository } from '@bike4mind/database/infra';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { toSafeSecretRotation } from '@client/lib/secretRotation/utils';
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
  if (!updated) throw new NotFoundError('Secret rotation not found');
  // Field-by-field like the list and renew responses: `previousKey` holds a live
  // signing secret during the grace window, so this route must not hand back the raw
  // document. Keeps the "every response naming these records is built field-by-field"
  // guarantee true for all three sites (see lib/secretRotation/utils.ts).
  return res.json(toSafeSecretRotation(updated));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { Permission } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { SecretRotation, secretRotationRepository } from '@bike4mind/database/infra';
import { ForbiddenError } from '@server/utils/errors';
import { SECRET_ROTATION_CONFIG } from '@client/lib/secretRotation/constants';
import { calculateNextRotationDate } from '@client/lib/secretRotation/utils';

const handler = baseApi()
  /**
   * Get all active secret rotations
   */
  .get(async (req, res) => {
    if (!req.ability?.can(Permission.read, SecretRotation)) {
      return new ForbiddenError();
    }

    const secrets = await secretRotationRepository.findActiveKeys();
    const configKeys = Object.keys(SECRET_ROTATION_CONFIG);
    const existingKeys = secrets.map(secret => secret.keyName);

    // Seed DB records for any config key not yet present
    for (const [key, config] of Object.entries(SECRET_ROTATION_CONFIG)) {
      if (!existingKeys.includes(key)) {
        await secretRotationRepository.create({
          keyName: key,
          description: config.description,
          rotatedAt: new Date(),
          nextRotation: calculateNextRotationDate(config.rotationIntervalDays),
          rotationIntervalDays: config.rotationIntervalDays,
          isActive: true,
        });
      }
    }

    // Filter to only keys present in the current config so the UI never shows
    // stale DB records for entries that have been removed or renamed.
    const filteredSecrets = secrets.filter(s => configKeys.includes(s.keyName));
    return res.json(filteredSecrets);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

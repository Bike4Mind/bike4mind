/**
 * Admin API for Tier 1 Secrets Status
 *
 * GET /api/admin/system-secrets/tier1-status
 *
 * Returns configuration status of Tier 1 infrastructure secrets.
 * These secrets cannot be configured via the admin GUI - they must be set using SST CLI.
 *
 * Security:
 * - Admin-only access
 * - Never returns actual secret values
 * - Only returns status: configured, placeholder, invalid, missing, or warning
 */

import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { Config } from '@server/utils/config';
import { Logger } from '@bike4mind/observability';
import {
  validateEncryptionKey,
  validateMongoUri,
  validateSessionSecret,
  validateJwtSecret,
  type ValidationStatus,
  type ValidationSeverity,
} from '@server/security/tier1SecretValidators';

interface Tier1SecretInfo {
  name: string;
  status: ValidationStatus;
  severity: ValidationSeverity;
  message?: string;
  hint?: string;
}

interface Tier1StatusResponse {
  stage: string;
  secrets: Tier1SecretInfo[];
}

/**
 * Gets the status of all Tier 1 secrets using shared validators
 */
function getTier1Status(stage: string): Tier1SecretInfo[] {
  const encryptionResult = validateEncryptionKey(Config.SECRET_ENCRYPTION_KEY);
  const mongoResult = validateMongoUri(Config.MONGODB_URI, stage);
  const sessionResult = validateSessionSecret(Config.SESSION_SECRET);
  const jwtResult = validateJwtSecret(Config.JWT_SECRET);

  return [
    {
      name: 'SECRET_ENCRYPTION_KEY',
      status: encryptionResult.status,
      severity: encryptionResult.severity,
      message: encryptionResult.message,
      hint:
        encryptionResult.status !== 'configured'
          ? `AWS_PROFILE=<your-profile> pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage ${stage}`
          : undefined,
    },
    {
      name: 'MONGODB_URI',
      status: mongoResult.status,
      severity: mongoResult.severity,
      message: mongoResult.message,
      hint:
        mongoResult.status !== 'configured'
          ? `AWS_PROFILE=<your-profile> pnpm sst secret set MONGODB_URI "mongodb+srv://..." --stage ${stage}`
          : undefined,
    },
    {
      name: 'SESSION_SECRET',
      status: sessionResult.status,
      severity: sessionResult.severity,
      message: sessionResult.message,
      hint:
        sessionResult.status !== 'configured'
          ? `AWS_PROFILE=<your-profile> pnpm sst secret set SESSION_SECRET "$(openssl rand -base64 48)" --stage ${stage}`
          : undefined,
    },
    {
      name: 'JWT_SECRET',
      status: jwtResult.status,
      severity: jwtResult.severity,
      message: jwtResult.message,
      hint:
        !jwtResult.isValid || jwtResult.status === 'warning'
          ? `AWS_PROFILE=<your-profile> pnpm sst secret set JWT_SECRET "$(openssl rand -base64 48)" --stage ${stage}`
          : undefined,
    },
  ];
}

const handler = baseApi().get(async (req, res) => {
  try {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const stage = Config.STAGE;
    const secrets = getTier1Status(stage);

    const response: Tier1StatusResponse = {
      stage,
      secrets,
    };

    return res.json(response);
  } catch (error) {
    Logger.error('Error fetching Tier 1 secrets status:', error);
    if (error instanceof ForbiddenError) {
      return res.status(403).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch Tier 1 secrets status' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

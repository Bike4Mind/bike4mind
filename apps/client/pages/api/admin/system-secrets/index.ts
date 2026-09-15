/**
 * Admin API for System Secrets
 *
 * GET /api/admin/system-secrets - List all configurable secrets with status
 * POST /api/admin/system-secrets - Create/update a secret value
 *
 * Security:
 * - Admin-only access
 * - Never returns decrypted secret values (masked with ****)
 * - All values encrypted with AES-256-GCM before storage
 */

import { systemSecretRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { encryptSecret, isValidEncryptionKey } from '@server/security/secretEncryption';
import { Config } from '@server/utils/config';
import {
  clearSecretCache,
  RESOLVABLE_SECRETS,
  resolveSecret,
  TIER1_SECRETS,
  type ResolvableSecretName,
} from '@server/managers/systemSecretsManager';
import { Logger } from '@bike4mind/observability';

/**
 * Mask a secret value for display (show only last 4 chars).
 */
function maskSecretValue(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return '****' + value.slice(-4);
}

const handler = baseApi()
  .get(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const dbSecrets = await systemSecretRepository.findAll();

      // Build response with resolution status for each configurable secret
      const secretsStatus = await Promise.all(
        Object.entries(RESOLVABLE_SECRETS).map(async ([secretName, config]) => {
          const dbSecret = dbSecrets.find(s => s.secretName === secretName);
          const resolution = await resolveSecret(secretName, true);

          return {
            secretName,
            category: config.category,
            description: config.description,
            isConfigured: !!resolution.value,
            source: resolution.source,
            maskedValue: maskSecretValue(resolution.value),
            isOverridable: !TIER1_SECRETS.has(secretName),
            dbRecord: dbSecret
              ? {
                  id: dbSecret.id,
                  source: dbSecret.source,
                  lastModifiedBy: dbSecret.lastModifiedBy,
                  rotatedAt: dbSecret.rotatedAt,
                  updatedAt: dbSecret.updatedAt,
                }
              : null,
            warnings: resolution.warnings,
          };
        })
      );

      return res.json({
        secrets: secretsStatus,
        tier1Note:
          'Tier 1 secrets (SECRET_ENCRYPTION_KEY, MONGODB_URI, SESSION_SECRET, JWT_SECRET) cannot be configured via this API. They must be set using SST CLI.',
      });
    } catch (error) {
      Logger.error('Error fetching system secrets status:', error);
      if (error instanceof ForbiddenError) {
        return res.status(403).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to fetch system secrets' });
    }
  })
  .post(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { secretName, value } = req.body;

      if (!secretName || typeof secretName !== 'string') {
        throw new BadRequestError('Secret name is required');
      }

      if (!value || typeof value !== 'string') {
        throw new BadRequestError('Secret value is required');
      }

      // Check if this is a Tier 1 secret (not allowed)
      if (TIER1_SECRETS.has(secretName)) {
        throw new BadRequestError(
          `${secretName} is a Tier 1 infrastructure secret and cannot be configured via this API. ` +
            `Use 'sst secret set ${secretName} <value>' instead.`
        );
      }

      // Check if this is a known secret
      const secretConfig = RESOLVABLE_SECRETS[secretName as ResolvableSecretName];
      if (!secretConfig) {
        throw new BadRequestError(`Unknown secret: ${secretName}. Only predefined secrets can be configured.`);
      }

      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
      if (!encryptionKey || !isValidEncryptionKey(encryptionKey)) {
        throw new BadRequestError('SECRET_ENCRYPTION_KEY is not configured. Cannot encrypt secrets.');
      }

      const encryptedValue = encryptSecret(value, encryptionKey);

      // Check if secret already exists
      const existingSecret = await systemSecretRepository.findBySecretName(secretName);

      if (existingSecret) {
        // Update existing secret
        await systemSecretRepository.updateSecret(existingSecret.id, {
          encryptedValue,
          source: 'gui_configured',
          lastModifiedBy: req.user!.id,
        });
        Logger.info(`[System Secrets] Updated secret ${secretName} by user ${req.user!.id}`);
      } else {
        // Create new secret
        await systemSecretRepository.upsertSecret(secretName, {
          encryptedValue,
          keyVersion: 1,
          category: secretConfig.category,
          source: 'gui_configured',
          isOverridable: true,
          description: secretConfig.description,
          lastModifiedBy: req.user!.id,
        });
        Logger.info(`[System Secrets] Created secret ${secretName} by user ${req.user!.id}`);
      }

      // Clear cache so new value is used immediately
      clearSecretCache(secretName);

      return res.status(existingSecret ? 200 : 201).json({
        success: true,
        secretName,
        source: 'gui_configured',
        maskedValue: maskSecretValue(value),
        message: existingSecret
          ? `Secret ${secretName} updated successfully`
          : `Secret ${secretName} created successfully`,
      });
    } catch (error) {
      Logger.error('Error creating/updating system secret:', error);
      if (error instanceof ForbiddenError) {
        return res.status(403).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to save system secret' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

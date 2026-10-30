/**
 * Admin API for individual System Secret operations
 *
 * GET /api/admin/system-secrets/[id] - Get secret status by ID
 * DELETE /api/admin/system-secrets/[id] - Delete DB override (revert to SST)
 *
 * Security:
 * - Admin-only access
 * - Never returns decrypted secret values
 */

import { systemSecretRepository, withTransaction } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { clearSecretCache, resolveSecret } from '@server/managers/systemSecretsManager';
import { Logger } from '@bike4mind/observability';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * Mask a secret value for display (show only last 4 chars).
 */
function maskSecretValue(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return '****' + value.slice(-4);
}

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    try {
      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Secret ID is required');
      }

      const secret = await systemSecretRepository.findById(id);

      if (!secret) {
        throw new NotFoundError('Secret not found');
      }

      // Get resolution status (includes decrypted value for masking)
      const resolution = await resolveSecret(secret.secretName, true);

      return res.json({
        id: secret.id,
        secretName: secret.secretName,
        category: secret.category,
        source: secret.source,
        isOverridable: secret.isOverridable,
        description: secret.description,
        maskedValue: maskSecretValue(resolution.value),
        lastModifiedBy: secret.lastModifiedBy,
        rotatedAt: secret.rotatedAt,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        warnings: resolution.warnings,
      });
    } catch (error) {
      Logger.error('Error fetching system secret:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to fetch system secret' });
    }
  })
  .delete(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    try {
      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Secret ID is required');
      }

      const secret = await systemSecretRepository.findById(id);

      if (!secret) {
        throw new NotFoundError('Secret not found');
      }

      // Delete the DB record (will fall back to SST value)
      await withTransaction(async () => {
        const deleted = await systemSecretRepository.deleteSecret(id);

        if (!deleted) {
          throw new NotFoundError('Secret not found');
        }

        await recordAdminActionFromRequest(req, {
          action: 'settings.system_secret.deleted',
          target: { kind: 'settings', id: secret.secretName, displayName: secret.secretName },
          summary: `deleted system secret override ${secret.secretName}`,
        });
      });

      // Clear cache so SST value is used
      clearSecretCache(secret.secretName);

      Logger.info(
        `[System Secrets] Deleted DB override for ${secret.secretName} by user ${req.user!.id} (will fall back to SST)`
      );

      return res.json({
        success: true,
        secretName: secret.secretName,
        message: `Database override for ${secret.secretName} deleted. Will now use SST value if available.`,
      });
    } catch (error) {
      Logger.error('Error deleting system secret:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to delete system secret' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

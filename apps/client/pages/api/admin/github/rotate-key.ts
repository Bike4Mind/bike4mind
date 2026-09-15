/**
 * Admin GitHub Rotate Key API
 *
 * Rotates the private key for a GitHub App connection.
 * Rate limited to 3 rotations per hour per connection.
 *
 * Security:
 * - Admin-only access
 * - Validates PEM format
 * - Encrypts key at rest
 *
 * @route POST /api/admin/github/rotate-key - Rotate the private key
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { orgGitHubConnectionRepository } from '@bike4mind/database';
import { encryptSecret } from '@server/security/secretEncryption';
import { Config } from '@server/utils/config';
import { BadRequestError, InternalServerError, NotFoundError, ensureAdmin } from '@server/utils/errors';
import { validatePrivateKeyFormat } from '@server/utils/validators';
import { Logger } from '@bike4mind/observability';
import { rateLimit } from '@server/middlewares/rateLimit';

const logger = new Logger({ metadata: { component: 'admin-github-rotate-key' } });

// Max length to prevent DoS via huge strings
const MAX_PRIVATE_KEY_LENGTH = 16384; // 16KB - covers RSA 4096-bit keys

// Validation schema
const RotateKeySchema = z.object({
  privateKey: z.string().min(1, 'privateKey is required').max(MAX_PRIVATE_KEY_LENGTH, 'privateKey too long'),
});

const handler = baseApi()
  // Rate limit to 3 rotations per hour
  .use(
    rateLimit({
      limit: 3,
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
  // POST - Rotate private key
  .post(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const parseResult = RotateKeySchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(parseResult.error.issues[0]?.message || 'Invalid request body');
    }

    const { privateKey } = parseResult.data;

    // Find the system default connection
    const connection = await orgGitHubConnectionRepository.findSystemDefault();
    if (!connection) {
      throw new NotFoundError('No GitHub connection found');
    }

    // Only GitHub App connections have private keys
    if (connection.connectionType !== 'github_app') {
      throw new BadRequestError('Key rotation is only available for GitHub App connections');
    }

    // Validate private key format
    if (!validatePrivateKeyFormat(privateKey)) {
      throw new BadRequestError('Invalid private key format. Expected PEM format.');
    }

    // Get encryption key
    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      // Use proper HTTP error for config failures
      throw new InternalServerError('Server configuration error');
    }

    // Encrypt the new private key
    const encryptedPrivateKey = encryptSecret(privateKey, encryptionKey);

    // Update the connection with new key and clear cached token
    await orgGitHubConnectionRepository.update({
      id: connection.id,
      privateKey: encryptedPrivateKey,
      cachedAccessToken: undefined,
      tokenExpiresAt: undefined,
      tokenCachedAt: undefined,
    });

    logger.info('[Admin] Rotated GitHub App private key', {
      connectionId: connection.id,
      adminUserId: req.user!.id,
    });

    return res.json({
      success: true,
      message: 'Private key rotated successfully. Cached tokens have been cleared.',
    });
  });

export default handler;

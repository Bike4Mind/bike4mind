/**
 * Organization GitHub Rotate Key API
 *
 * Rotates the private key for a GitHub App connection.
 * Rate limited to 3 rotations per hour per organization.
 *
 * Security:
 * - Org owner or manager access required
 * - Validates PEM format
 * - Encrypts key at rest
 * - Audit logged
 *
 * @route POST /api/organizations/[id]/github/rotate-key - Rotate the private key
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { orgGitHubConnectionRepository } from '@bike4mind/database';
import { encryptSecret } from '@server/security/secretEncryption';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { Config } from '@server/utils/config';
import { BadRequestError, InternalServerError, NotFoundError } from '@bike4mind/utils';
import { validatePrivateKeyFormat } from '@server/utils/validators';
import { Logger } from '@bike4mind/observability';
import { rateLimit } from '@server/middlewares/rateLimit';
import { logKeyRotated } from '@server/integrations/github/githubConnectionAuditLog';

const logger = new Logger({ metadata: { component: 'org-github-rotate-key' } });

// max length guards against DoS via huge strings
const MAX_PRIVATE_KEY_LENGTH = 16384; // 16KB - covers RSA 4096-bit keys

const RotateKeySchema = z.object({
  privateKey: z.string().min(1, 'privateKey is required').max(MAX_PRIVATE_KEY_LENGTH, 'privateKey too long'),
});

const handler = baseApi()
  .use(
    rateLimit({
      limit: 3,
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
  .post(async (req, res) => {
    const orgId = req.query.id as string;
    const user = req.user!;

    await verifyOrgAccess(user, orgId);

    const parseResult = RotateKeySchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(parseResult.error.issues[0]?.message || 'Invalid request body');
    }

    const { privateKey } = parseResult.data;

    const connection = await orgGitHubConnectionRepository.findByOrganizationId(orgId);
    if (!connection) {
      throw new NotFoundError('No GitHub connection found for this organization');
    }

    // only GitHub App connections have private keys; generic message avoids
    // revealing connection type to unauthorized users
    if (connection.connectionType !== 'github_app') {
      throw new BadRequestError('This operation is not supported for this connection type');
    }

    if (!validatePrivateKeyFormat(privateKey)) {
      throw new BadRequestError('Invalid private key format. Expected PEM format.');
    }

    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new InternalServerError('Server configuration error');
    }

    const encryptedPrivateKey = encryptSecret(privateKey, encryptionKey);

    // clear the cached token too - it was minted from the key being replaced
    await orgGitHubConnectionRepository.update({
      id: connection.id,
      privateKey: encryptedPrivateKey,
      cachedAccessToken: undefined,
      tokenExpiresAt: undefined,
      tokenCachedAt: undefined,
    });

    logKeyRotated({
      connectionId: connection.id,
      organizationId: orgId,
      actorUserId: user.id,
      connectionType: 'github_app',
    });

    logger.info('[Org] Rotated GitHub App private key', {
      connectionId: connection.id,
      organizationId: orgId,
      userId: user.id,
    });

    return res.json({
      success: true,
      message: 'Private key rotated successfully. Cached tokens have been cleared.',
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

/**
 * Organization GitHub Rotate PAT API
 *
 * Rotates the Personal Access Token for a Service Account connection.
 * Rate limited to 3 rotations per hour per organization.
 *
 * Security:
 * - Org owner or manager access required
 * - Encrypts token at rest
 * - Audit logged
 *
 * @route POST /api/organizations/[id]/github/rotate-pat - Rotate the PAT
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { orgGitHubConnectionRepository } from '@bike4mind/database';
import { encryptSecret } from '@server/security/secretEncryption';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { Config } from '@server/utils/config';
import { BadRequestError, InternalServerError, NotFoundError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { rateLimit } from '@server/middlewares/rateLimit';
import { logPatRotated } from '@server/integrations/github/githubConnectionAuditLog';

const logger = new Logger({ metadata: { component: 'org-github-rotate-pat' } });

// max length guards against DoS via huge strings
const MAX_ACCESS_TOKEN_LENGTH = 500; // GitHub PATs are ~100 chars

const RotatePATSchema = z.object({
  accessToken: z.string().min(1, 'accessToken is required').max(MAX_ACCESS_TOKEN_LENGTH, 'accessToken too long'),
  patExpiresAt: z.iso.datetime().optional(),
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

    const parseResult = RotatePATSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(parseResult.error.issues[0]?.message || 'Invalid request body');
    }

    const { accessToken, patExpiresAt } = parseResult.data;

    const connection = await orgGitHubConnectionRepository.findByOrganizationId(orgId);
    if (!connection) {
      throw new NotFoundError('No GitHub connection found for this organization');
    }

    // only service_account (PAT) connections can rotate a PAT; generic message
    // avoids revealing connection type to unauthorized users
    if (connection.connectionType !== 'service_account') {
      throw new BadRequestError('This operation is not supported for this connection type');
    }

    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new InternalServerError('Server configuration error');
    }

    const encryptedAccessToken = encryptSecret(accessToken, encryptionKey);

    await orgGitHubConnectionRepository.update({
      id: connection.id,
      accessToken: encryptedAccessToken,
      patExpiresAt: patExpiresAt ? new Date(patExpiresAt) : undefined,
    });

    logPatRotated({
      connectionId: connection.id,
      organizationId: orgId,
      actorUserId: user.id,
      connectionType: 'service_account',
    });

    logger.info('[Org] Rotated GitHub PAT', {
      connectionId: connection.id,
      organizationId: orgId,
      userId: user.id,
      hasExpiration: !!patExpiresAt,
    });

    return res.json({
      success: true,
      message: 'Personal Access Token rotated successfully.',
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

/**
 * Organization GitHub Connection API
 *
 * Manages organization-level GitHub API connections for outbound calls.
 * Supports both GitHub App and Service Account PAT authentication.
 *
 * Security:
 * - Org owner or manager access required
 * - Credentials encrypted at rest using AES-256-GCM
 * - Masked credentials in responses (except one-time reveal on creation)
 * - Audit logging for all mutations
 *
 * @route POST /api/organizations/[id]/github/connection - Create connection
 * @route GET /api/organizations/[id]/github/connection - Get connection status
 * @route PUT /api/organizations/[id]/github/connection - Update connection
 * @route DELETE /api/organizations/[id]/github/connection - Disconnect
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { orgGitHubConnectionRepository } from '@bike4mind/database';
import { encryptSecret, isEncrypted, decryptSecret } from '@server/security/secretEncryption';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { Config } from '@server/utils/config';
import { BadRequestError, InternalServerError, NotFoundError } from '@bike4mind/utils';
import { validatePrivateKeyFormat } from '@server/utils/validators';
import { Logger } from '@bike4mind/observability';
import {
  IOrgGitHubConnectionDocument,
  IOrgGitHubConnectionResponse,
  IOrgGitHubConnectionHealth,
} from '@bike4mind/common';
import { rateLimit } from '@server/middlewares/rateLimit';
import {
  logConnectionCreated,
  logConnectionUpdated,
  logConnectionDeleted,
} from '@server/integrations/github/githubConnectionAuditLog';

const logger = new Logger({ metadata: { component: 'org-github-connection' } });

// max lengths guard against DoS via huge strings
const MAX_PRIVATE_KEY_LENGTH = 16384; // 16KB - covers RSA 4096-bit keys
const MAX_ACCESS_TOKEN_LENGTH = 500; // GitHub PATs are ~100 chars
const MAX_REPO_NAME_LENGTH = 200; // owner/repo format
const MAX_ALLOWED_REPOS = 100; // limit number of whitelisted repos

// GitHub naming constraints: owner is 1-39 chars, alphanumeric or single
// hyphens (not at start/end); repo is 1-100 chars, alphanumeric, dots,
// underscores, hyphens
const GITHUB_REPO_FORMAT_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}\/[a-zA-Z0-9._-]{1,100}$/;

const repoFormatSchema = z
  .string()
  .max(MAX_REPO_NAME_LENGTH)
  .regex(GITHUB_REPO_FORMAT_REGEX, 'Invalid repository format. Expected: owner/repo');

// Validation schemas
const ConnectGitHubAppSchema = z.object({
  connectionType: z.literal('github_app'),
  appId: z.string().min(1, 'appId is required').max(50, 'appId too long'),
  installationId: z.string().min(1, 'installationId is required').max(50, 'installationId too long'),
  privateKey: z.string().min(1, 'privateKey is required').max(MAX_PRIVATE_KEY_LENGTH, 'privateKey too long'),
  allowedRepositories: z.array(repoFormatSchema).max(MAX_ALLOWED_REPOS, 'Too many repositories').optional(),
});

const ConnectGitHubPATSchema = z.object({
  connectionType: z.literal('service_account'),
  accessToken: z.string().min(1, 'accessToken is required').max(MAX_ACCESS_TOKEN_LENGTH, 'accessToken too long'),
  patExpiresAt: z.iso.datetime().optional(),
  allowedRepositories: z.array(repoFormatSchema).max(MAX_ALLOWED_REPOS, 'Too many repositories').optional(),
});

const ConnectSchema = z.discriminatedUnion('connectionType', [ConnectGitHubAppSchema, ConnectGitHubPATSchema]);

const UpdateSchema = z.object({
  allowedRepositories: z.array(repoFormatSchema).max(MAX_ALLOWED_REPOS, 'Too many repositories').optional(),
  enabled: z.boolean().optional(),
});

/**
 * Mask a secret for display (show only last 4 characters)
 */
function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 4) {
    return '****';
  }
  return '*'.repeat(secret.length - 4) + secret.slice(-4);
}

/**
 * Build API response from connection document
 */
function buildResponse(
  connection: IOrgGitHubConnectionDocument,
  options?: { decryptedPrivateKey?: string; decryptedAccessToken?: string }
): IOrgGitHubConnectionResponse {
  const health: IOrgGitHubConnectionHealth = {
    lastUsedAt: connection.lastUsedAt?.toISOString(),
    lastLatencyMs: connection.lastLatencyMs,
    lastError: connection.lastError || undefined,
    rateLimitRemaining: connection.rateLimitRemaining,
    rateLimitLimit: connection.rateLimitLimit,
    rateLimitResetAt: connection.rateLimitResetAt?.toISOString(),
  };

  const response: IOrgGitHubConnectionResponse = {
    id: connection.id,
    organizationId: connection.organizationId,
    connectionType: connection.connectionType,
    connectedBy: connection.connectedBy,
    connectedAt: connection.connectedAt.toISOString(),
    allowedRepositories: connection.allowedRepositories || [],
    enabled: connection.enabled,
    isSystemDefault: connection.isSystemDefault,
    health,
    createdAt:
      (connection as unknown as { createdAt: Date }).createdAt?.toISOString() || connection.connectedAt.toISOString(),
    updatedAt:
      (connection as unknown as { updatedAt: Date }).updatedAt?.toISOString() || connection.connectedAt.toISOString(),
  };

  if (connection.connectionType === 'github_app') {
    response.appId = connection.appId;
    response.installationId = connection.installationId;
    response.installationTargetType = connection.installationTargetType;
    response.installationTargetId = connection.installationTargetId;
    response.repositorySelection = connection.repositorySelection;
    response.permissions = connection.permissions;

    if (options?.decryptedPrivateKey) {
      response.privateKeyMasked = maskSecret(options.decryptedPrivateKey);
    }
  } else {
    response.patExpiresAt = connection.patExpiresAt?.toISOString();

    if (options?.decryptedAccessToken) {
      response.accessTokenMasked = maskSecret(options.decryptedAccessToken);
    }
  }

  if (connection.suspendedAt) {
    response.suspendedAt = connection.suspendedAt.toISOString();
  }

  return response;
}

const handler = baseApi()
  // rate limits all connection operations (GET/POST/PUT/DELETE) against brute-force and abuse
  .use(
    rateLimit({
      limit: 60,
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
  .post(async (req, res) => {
    const orgId = req.query.id as string;
    const user = req.user!;

    // owner/manager or admin only
    await verifyOrgAccess(user, orgId);

    const parseResult = ConnectSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(parseResult.error.issues[0]?.message || 'Invalid request body');
    }

    const data = parseResult.data;

    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new InternalServerError('Server configuration error');
    }

    let connectionData: Parameters<typeof orgGitHubConnectionRepository.create>[0];

    if (data.connectionType === 'github_app') {
      if (!validatePrivateKeyFormat(data.privateKey)) {
        throw new BadRequestError('Invalid private key format. Expected PEM format.');
      }

      const encryptedPrivateKey = encryptSecret(data.privateKey, encryptionKey);

      connectionData = {
        organizationId: orgId,
        connectionType: 'github_app',
        appId: data.appId,
        installationId: data.installationId,
        privateKey: encryptedPrivateKey,
        allowedRepositories: data.allowedRepositories || [],
        connectedBy: user.id,
        connectedAt: new Date(),
        enabled: true,
        isSystemDefault: false,
      };
    } else {
      const encryptedAccessToken = encryptSecret(data.accessToken, encryptionKey);

      connectionData = {
        organizationId: orgId,
        connectionType: 'service_account',
        accessToken: encryptedAccessToken,
        patExpiresAt: data.patExpiresAt ? new Date(data.patExpiresAt) : undefined,
        allowedRepositories: data.allowedRepositories || [],
        connectedBy: user.id,
        connectedAt: new Date(),
        enabled: true,
        isSystemDefault: false,
      };
    }

    let connection: IOrgGitHubConnectionDocument;
    try {
      connection = await orgGitHubConnectionRepository.create(connectionData);
    } catch (error) {
      // E11000 = MongoDB duplicate key, from a create race
      if ((error as { code?: number }).code === 11000) {
        throw new BadRequestError(
          'A GitHub connection already exists for this organization. Delete the existing connection first.'
        );
      }
      throw error;
    }

    logConnectionCreated(
      {
        connectionId: connection.id,
        organizationId: orgId,
        actorUserId: user.id,
        connectionType: data.connectionType,
      },
      data.allowedRepositories?.length
    );

    logger.info('[Org] Created GitHub connection', {
      connectionId: connection.id,
      connectionType: data.connectionType,
      organizationId: orgId,
      userId: user.id,
    });

    const response = buildResponse(connection, {
      decryptedPrivateKey: data.connectionType === 'github_app' ? data.privateKey : undefined,
      decryptedAccessToken: data.connectionType === 'service_account' ? data.accessToken : undefined,
    });

    return res.status(201).json(response);
  })

  .get(async (req, res) => {
    const orgId = req.query.id as string;
    const user = req.user!;

    await verifyOrgAccess(user, orgId);

    // findByOrganizationIdAny so managers can also see disabled connections
    const connection = await orgGitHubConnectionRepository.findByOrganizationIdAny(orgId);
    if (!connection) {
      return res.json({ connected: false });
    }

    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    let decryptedPrivateKey: string | undefined;
    let decryptedAccessToken: string | undefined;

    // corrupt/invalid encrypted data shouldn't fail the request, just skip masking
    if (encryptionKey) {
      try {
        if (connection.connectionType === 'github_app') {
          const connWithCreds = await orgGitHubConnectionRepository.findByOrganizationIdAnyWithCredentials(orgId);
          if (connWithCreds?.privateKey && isEncrypted(connWithCreds.privateKey)) {
            decryptedPrivateKey = decryptSecret(connWithCreds.privateKey, encryptionKey);
          }
        } else if (connection.connectionType === 'service_account') {
          const connWithCreds = await orgGitHubConnectionRepository.findByOrganizationIdAnyWithCredentials(orgId);
          if (connWithCreds?.accessToken && isEncrypted(connWithCreds.accessToken)) {
            decryptedAccessToken = decryptSecret(connWithCreds.accessToken, encryptionKey);
          }
        }
      } catch (error) {
        logger.error('[Org] Failed to decrypt credentials for masking', {
          connectionId: connection.id,
          organizationId: orgId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const response = buildResponse(connection, {
      decryptedPrivateKey,
      decryptedAccessToken,
    });

    return res.json({ connected: true, connection: response });
  })

  .put(async (req, res) => {
    const orgId = req.query.id as string;
    const user = req.user!;

    await verifyOrgAccess(user, orgId);

    const parseResult = UpdateSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(parseResult.error.issues[0]?.message || 'Invalid request body');
    }

    const data = parseResult.data;

    // atomic findOneAndUpdate avoids a TOCTOU race condition
    const updateFields: Record<string, unknown> = {};
    if (data.allowedRepositories !== undefined) {
      updateFields.allowedRepositories = data.allowedRepositories;
    }
    if (data.enabled !== undefined) {
      updateFields.enabled = data.enabled;
    }

    // returns the document as it was before the update, for change tracking
    const connection = await orgGitHubConnectionRepository.findOneAndUpdate({ organizationId: orgId }, updateFields);

    if (!connection) {
      throw new NotFoundError('No GitHub connection found for this organization');
    }

    const changedFields: string[] = [];
    const auditChanges: {
      previousEnabled?: boolean;
      newEnabled?: boolean;
      allowedReposCount?: number;
    } = {};

    if (data.allowedRepositories !== undefined) {
      changedFields.push('allowedRepositories');
      auditChanges.allowedReposCount = data.allowedRepositories.length;
    }
    if (data.enabled !== undefined && data.enabled !== connection.enabled) {
      changedFields.push('enabled');
      auditChanges.previousEnabled = connection.enabled;
      auditChanges.newEnabled = data.enabled;
    }

    const updated = await orgGitHubConnectionRepository.findByOrganizationIdAny(orgId);
    if (!updated) {
      throw new NotFoundError('Failed to retrieve updated connection');
    }

    if (changedFields.length > 0) {
      logConnectionUpdated(
        {
          connectionId: connection.id,
          organizationId: orgId,
          actorUserId: user.id,
          connectionType: connection.connectionType,
        },
        changedFields,
        auditChanges
      );
    }

    logger.info('[Org] Updated GitHub connection', {
      connectionId: connection.id,
      organizationId: orgId,
      updates: changedFields,
      userId: user.id,
    });

    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    let decryptedPrivateKey: string | undefined;
    let decryptedAccessToken: string | undefined;

    if (encryptionKey) {
      try {
        // Any version so disabled connections are handled too
        const connWithCreds = await orgGitHubConnectionRepository.findByOrganizationIdAnyWithCredentials(orgId);
        if (
          connWithCreds?.connectionType === 'github_app' &&
          connWithCreds.privateKey &&
          isEncrypted(connWithCreds.privateKey)
        ) {
          decryptedPrivateKey = decryptSecret(connWithCreds.privateKey, encryptionKey);
        } else if (
          connWithCreds?.connectionType === 'service_account' &&
          connWithCreds.accessToken &&
          isEncrypted(connWithCreds.accessToken)
        ) {
          decryptedAccessToken = decryptSecret(connWithCreds.accessToken, encryptionKey);
        }
      } catch (error) {
        logger.error('[Org] Failed to decrypt credentials for masking', {
          connectionId: updated.id,
          organizationId: orgId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const response = buildResponse(updated, {
      decryptedPrivateKey,
      decryptedAccessToken,
    });

    return res.json({ connection: response });
  })

  .delete(async (req, res) => {
    const orgId = req.query.id as string;
    const user = req.user!;

    await verifyOrgAccess(user, orgId);

    // findByOrganizationIdAny so disabled connections can be deleted too
    const connection = await orgGitHubConnectionRepository.findByOrganizationIdAny(orgId);
    if (!connection) {
      throw new NotFoundError('No GitHub connection found for this organization');
    }

    await orgGitHubConnectionRepository.delete(connection.id);

    logConnectionDeleted({
      connectionId: connection.id,
      organizationId: orgId,
      actorUserId: user.id,
      connectionType: connection.connectionType,
    });

    logger.info('[Org] Deleted GitHub connection', {
      connectionId: connection.id,
      connectionType: connection.connectionType,
      organizationId: orgId,
      userId: user.id,
    });

    return res.json({ success: true, message: 'GitHub connection deleted successfully' });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

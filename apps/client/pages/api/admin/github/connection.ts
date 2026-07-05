/**
 * Admin GitHub Connection API
 *
 * Manages the system-level GitHub API connection for outbound calls.
 * Supports both GitHub App and Service Account PAT authentication.
 *
 * Security:
 * - Admin-only access
 * - Credentials encrypted at rest using AES-256-GCM
 * - Masked credentials in responses (except one-time reveal on creation)
 *
 * @route POST /api/admin/github/connection - Create connection
 * @route GET /api/admin/github/connection - Get connection status
 * @route PUT /api/admin/github/connection - Update connection
 * @route DELETE /api/admin/github/connection - Disconnect
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { orgGitHubConnectionRepository } from '@bike4mind/database';
import { encryptSecret, isEncrypted, decryptSecret } from '@server/security/secretEncryption';
import { Config } from '@server/utils/config';
import { BadRequestError, InternalServerError, NotFoundError, ensureAdmin } from '@server/utils/errors';
import { validatePrivateKeyFormat } from '@server/utils/validators';
import { Logger } from '@bike4mind/observability';
import {
  IOrgGitHubConnectionDocument,
  IOrgGitHubConnectionResponse,
  IOrgGitHubConnectionHealth,
} from '@bike4mind/common';
import { rateLimit } from '@server/middlewares/rateLimit';

const logger = new Logger({ metadata: { component: 'admin-github-connection' } });

// Max lengths to prevent DoS via huge strings
const MAX_PRIVATE_KEY_LENGTH = 16384; // 16KB - covers RSA 4096-bit keys
const MAX_ACCESS_TOKEN_LENGTH = 500; // GitHub PATs are ~100 chars
const MAX_REPO_NAME_LENGTH = 200; // owner/repo format

// GitHub naming constraints validation
// Owner: 1-39 chars, alphanumeric or single hyphens (not at start/end)
// Repo: 1-100 chars, alphanumeric, dots, underscores, hyphens
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
  allowedRepositories: z.array(repoFormatSchema).optional(),
});

const ConnectGitHubPATSchema = z.object({
  connectionType: z.literal('service_account'),
  accessToken: z.string().min(1, 'accessToken is required').max(MAX_ACCESS_TOKEN_LENGTH, 'accessToken too long'),
  patExpiresAt: z.iso.datetime().optional(),
  allowedRepositories: z.array(repoFormatSchema).optional(),
});

const ConnectSchema = z.discriminatedUnion('connectionType', [ConnectGitHubAppSchema, ConnectGitHubPATSchema]);

const UpdateSchema = z.object({
  allowedRepositories: z.array(repoFormatSchema).optional(),
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

    // Show masked version of private key
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
  // Rate limit all connection operations (GET/POST/PUT/DELETE) to prevent brute-force and abuse
  .use(
    rateLimit({
      limit: 60,
      windowMs: 60 * 60 * 1000, // 60 requests per hour (allows normal GET usage while protecting mutations)
    })
  )
  // POST - Create GitHub connection
  .post(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const parseResult = ConnectSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(parseResult.error.issues[0]?.message || 'Invalid request body');
    }

    const data = parseResult.data;

    // Check if system connection already exists
    const existing = await orgGitHubConnectionRepository.findSystemDefault();
    if (existing) {
      throw new BadRequestError('A GitHub connection already exists. Delete the existing connection first.');
    }

    // Get encryption key
    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      // Use proper HTTP error for config failures
      throw new InternalServerError('Server configuration error');
    }

    let connectionData: Parameters<typeof orgGitHubConnectionRepository.create>[0];

    if (data.connectionType === 'github_app') {
      // Validate private key format
      if (!validatePrivateKeyFormat(data.privateKey)) {
        throw new BadRequestError('Invalid private key format. Expected PEM format.');
      }

      // Encrypt the private key
      const encryptedPrivateKey = encryptSecret(data.privateKey, encryptionKey);

      connectionData = {
        organizationId: null, // System-level connection
        connectionType: 'github_app',
        appId: data.appId,
        installationId: data.installationId,
        privateKey: encryptedPrivateKey,
        allowedRepositories: data.allowedRepositories || [],
        connectedBy: req.user!.id,
        connectedAt: new Date(),
        enabled: true,
        isSystemDefault: true,
      };
    } else {
      // Encrypt the access token
      const encryptedAccessToken = encryptSecret(data.accessToken, encryptionKey);

      connectionData = {
        organizationId: null, // System-level connection
        connectionType: 'service_account',
        accessToken: encryptedAccessToken,
        patExpiresAt: data.patExpiresAt ? new Date(data.patExpiresAt) : undefined,
        allowedRepositories: data.allowedRepositories || [],
        connectedBy: req.user!.id,
        connectedAt: new Date(),
        enabled: true,
        isSystemDefault: true,
      };
    }

    const connection = await orgGitHubConnectionRepository.create(connectionData);

    logger.info('[Admin] Created GitHub connection', {
      connectionId: connection.id,
      connectionType: data.connectionType,
      adminUserId: req.user!.id,
    });

    // Build response with masked secrets
    const response = buildResponse(connection, {
      decryptedPrivateKey: data.connectionType === 'github_app' ? data.privateKey : undefined,
      decryptedAccessToken: data.connectionType === 'service_account' ? data.accessToken : undefined,
    });

    return res.status(201).json(response);
  })

  // GET - Get GitHub connection status
  .get(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const connection = await orgGitHubConnectionRepository.findSystemDefault();
    if (!connection) {
      return res.json({ connected: false });
    }

    // Get encryption key to mask secrets
    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    let decryptedPrivateKey: string | undefined;
    let decryptedAccessToken: string | undefined;

    // Wrap decryption in try-catch to handle corrupt/invalid encrypted data
    if (encryptionKey) {
      try {
        if (connection.connectionType === 'github_app' && connection.privateKey) {
          // We need to get credentials to mask them
          const connWithCreds = await orgGitHubConnectionRepository.findSystemDefaultWithCredentials();
          if (connWithCreds?.privateKey && isEncrypted(connWithCreds.privateKey)) {
            decryptedPrivateKey = decryptSecret(connWithCreds.privateKey, encryptionKey);
          }
        } else if (connection.connectionType === 'service_account') {
          const connWithCreds = await orgGitHubConnectionRepository.findSystemDefaultWithCredentials();
          if (connWithCreds?.accessToken && isEncrypted(connWithCreds.accessToken)) {
            decryptedAccessToken = decryptSecret(connWithCreds.accessToken, encryptionKey);
          }
        }
      } catch (error) {
        // Log but don't fail - just won't show masked credentials
        logger.error('[Admin] Failed to decrypt credentials for masking', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const response = buildResponse(connection, {
      decryptedPrivateKey,
      decryptedAccessToken,
    });

    logger.info('[Admin] Fetched GitHub connection', {
      connectionId: connection.id,
      adminUserId: req.user!.id,
    });

    return res.json({ connected: true, connection: response });
  })

  // PUT - Update GitHub connection
  .put(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const parseResult = UpdateSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(parseResult.error.issues[0]?.message || 'Invalid request body');
    }

    const data = parseResult.data;

    const connection = await orgGitHubConnectionRepository.findSystemDefault();
    if (!connection) {
      throw new NotFoundError('No GitHub connection found');
    }

    // Update the connection
    const updated = await orgGitHubConnectionRepository.update({
      id: connection.id,
      allowedRepositories: data.allowedRepositories,
      enabled: data.enabled,
    });

    if (!updated) {
      throw new NotFoundError('Failed to update connection');
    }

    logger.info('[Admin] Updated GitHub connection', {
      connectionId: connection.id,
      updates: Object.keys(data),
      adminUserId: req.user!.id,
    });

    // Get encryption key to mask secrets for response
    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    let decryptedPrivateKey: string | undefined;
    let decryptedAccessToken: string | undefined;

    // Wrap decryption in try-catch to handle corrupt/invalid encrypted data (consistent with GET)
    if (encryptionKey) {
      try {
        const connWithCreds = await orgGitHubConnectionRepository.findSystemDefaultWithCredentials();
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
        // Log but don't fail - just won't show masked credentials
        logger.error('[Admin] Failed to decrypt credentials for masking', {
          connectionId: updated.id,
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

  // DELETE - Delete GitHub connection
  .delete(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const connection = await orgGitHubConnectionRepository.findSystemDefault();
    if (!connection) {
      throw new NotFoundError('No GitHub connection found');
    }

    await orgGitHubConnectionRepository.delete(connection.id);

    logger.info('[Admin] Deleted GitHub connection', {
      connectionId: connection.id,
      connectionType: connection.connectionType,
      adminUserId: req.user!.id,
    });

    return res.json({ success: true, message: 'GitHub connection deleted successfully' });
  });

export default handler;

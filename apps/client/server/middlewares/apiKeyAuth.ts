import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { User } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { UnauthorizedError, ForbiddenError } from '@server/utils/errors';
import { logEvent } from '@server/utils/analyticsLog';
import { UserApiKeyEvents } from '@bike4mind/common';
import ability from '@server/auth/ability';
import { Request, Response, NextFunction } from 'express';
import { ApiKeyUsageManager } from '@server/managers/apiKeyUsageManager';
import { getClientIp } from '@server/utils/ip';
import { createHash } from 'crypto';

/**
 * Hashes an API key for safe logging (avoids exposing partial credentials)
 */
const hashApiKeyForLogging = (apiKey: string): string => {
  return createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
};

/**
 * Middleware to authenticate API keys alongside JWT tokens
 * This middleware should be used after JWT auth middleware
 *
 * @param requiredScopes - When provided, the authenticated key must hold at
 *   least one of these scopes (OR / "any of" semantics) or the request is
 *   rejected with 403. Omitted -> no scope requirement (any valid key passes).
 */
export const apiKeyAuth = (requiredScopes?: ApiKeyScope[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // If already authenticated via JWT, skip API key auth
    if (req.user) {
      return next();
    }

    const apiKey =
      (req.headers['x-api-key'] as string) ||
      (req.headers.authorization?.startsWith('ApiKey ') ? req.headers.authorization.substring(7) : null);

    if (!apiKey) {
      return next(); // Let it fall through to normal auth failure
    }

    try {
      const startTime = Date.now();

      const validation = await userApiKeyService.validateUserApiKey(apiKey, {
        db: {
          userApiKeys: userApiKeyRepository,
        },
      });

      if (!validation.isValid) {
        const failIp =
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          (req.headers['x-real-ip'] as string) ||
          req.connection.remoteAddress ||
          'unknown';
        req.logger?.warn(`API key validation failed: ${validation.reason}`, {
          keyHash: hashApiKeyForLogging(apiKey),
          productId: validation.productId,
          reason: validation.reason,
          ip: failIp,
          userAgent: req.headers['user-agent'],
        });
        throw new UnauthorizedError('Invalid API key');
      }

      // Check required scopes (OR / "any of" semantics): the key must hold at
      // least one of the required scopes. Matches the CLI verifyApiKey convention
      // (cli/auth.ts DEFAULT_COMPLETION_SCOPES) so a generate-or-chat key isn't
      // split across endpoints.
      if (requiredScopes && !requiredScopes.some(scope => validation.scopes?.includes(scope))) {
        // A scope 403 fires before req.apiKeyInfo is set, so log from `validation`
        // (never the raw key) - otherwise the only trace is errorHandler's generic warn.
        req.logger?.warn('API key scope check failed', {
          keyHash: hashApiKeyForLogging(apiKey),
          keyId: validation.keyId,
          userId: validation.userId,
          heldScopes: validation.scopes,
          requiredScopes,
          endpoint: req.originalUrl,
        });
        throw new ForbiddenError('Insufficient API key permissions');
      }

      const user = await User.findById(validation.userId);
      if (!user || user.isBanned) {
        throw new UnauthorizedError('User not found or banned');
      }
      if (user.disputePending) {
        throw new ForbiddenError('Account suspended pending dispute resolution. Please contact support.');
      }
      // Block API-key access for accounts suspended for repeated content-policy violations.
      if (user.moderation?.status === 'suspended') {
        throw new ForbiddenError(
          'Your account is suspended for repeated content-policy violations. Please contact support to appeal.'
        );
      }

      req.user = user;
      req.apiKeyInfo = {
        keyId: validation.keyId!,
        scopes: validation.scopes!,
        rateLimit: validation.rateLimit!,
        productId: validation.productId,
      };

      // Create CASL ability for the user
      req.ability = ability(user);

      // Resolve client IP via the shared util. It walks the canonical CDN
      // headers (cf-connecting-ip, true-client-ip, x-real-ip, ...) in priority
      // order and filters private/reserved ranges, so a spoofed leftmost
      // x-forwarded-for value can no longer poison the IP we record. This
      // ipAddress feeds anomaly-detection baselines and new-IP alerts via
      // req._apiKeyUsageInfo, so trusting the raw header here was a
      // detection-evasion vector.
      const ipAddress = getClientIp(req);

      // Log API key usage to analytics (fire and forget)
      // Note: keyPrefix is named for type compatibility but contains a hash for security
      const responseTime = Date.now() - startTime;
      logEvent(
        {
          userId: validation.userId,
          type: UserApiKeyEvents.USED,
          metadata: {
            keyId: validation.keyId!,
            keyPrefix: hashApiKeyForLogging(apiKey), // Hash instead of prefix for security
            endpoint: req.originalUrl,
            method: req.method,
            responseTime,
            statusCode: 200, // Will be updated by response middleware if needed
          },
        },
        { ability: req.ability }
      ).catch(err => {
        req.logger?.warn('Failed to log API key usage to analytics', err);
      });

      // Store API key info for detailed logging after response
      // Determine endpoint for logging (fallback to req.url if originalUrl is not available)
      const endpointPath = req.originalUrl || req.url || (req as any).path || req.baseUrl || 'unknown';

      const userId = validation.userId ?? user?.id;
      if (!userId) {
        throw new UnauthorizedError('API key validation missing user id');
      }

      const usageInfo = {
        keyId: validation.keyId!,
        userId,
        ipAddress,
        endpoint: endpointPath,
        method: req.method,
        startTime,
      };
      req._apiKeyUsageInfo = usageInfo;

      // Log usage when response finishes (works for both res.json() and res.send())
      // Using 'finish' event ensures statusCode is set and response is complete
      res.once('finish', () => {
        const statusCode = res.statusCode || 200;
        const finalResponseTime = Date.now() - usageInfo.startTime;

        req.logger?.info('API key response finished, logging usage', {
          keyId: usageInfo.keyId,
          userId: usageInfo.userId,
          endpoint: usageInfo.endpoint,
          statusCode,
          responseTime: finalResponseTime,
        });

        // Log detailed API key usage (fire and forget)
        ApiKeyUsageManager.logUsage({
          keyId: usageInfo.keyId,
          userId: usageInfo.userId,
          ipAddress: usageInfo.ipAddress,
          endpoint: usageInfo.endpoint,
          method: usageInfo.method,
          responseTime: finalResponseTime,
          statusCode,
          logger: req.logger,
        }).catch(err => {
          req.logger?.warn('Failed to log detailed API key usage', err);
        });
      });

      req.logger?.info(`API key authenticated user: ${user.id}`, {
        keyId: validation.keyId,
        scopes: validation.scopes,
        endpoint: req.originalUrl,
      });

      next();
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
        throw error;
      }

      req.logger?.error('API key authentication error', error);
      throw new UnauthorizedError('Authentication failed');
    }
  };
};

/**
 * Helper function to check if request was authenticated via API key
 */
export const isApiKeyAuth = (req: Request): boolean => {
  return !!req.apiKeyInfo;
};

/**
 * Helper function to get API key scopes from request
 */
export const getApiKeyScopes = (req: Request): ApiKeyScope[] => {
  return req.apiKeyInfo?.scopes || [];
};

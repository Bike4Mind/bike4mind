import { cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { RequestHandler } from 'express';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const IDEMPOTENCY_TTL = 60 * 60; // 1 hour in seconds

interface IdempotencyOptions {
  /**
   * Whether to enforce the presence of an idempotency key
   * If true, requests without an idempotency key will be rejected
   */
  enforceKey?: boolean;

  /**
   * List of HTTP methods that require idempotency
   * Defaults to ['POST', 'PUT', 'PATCH', 'DELETE']
   */
  methods?: string[];
}

interface CachedResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
}

/**
 * Middleware to handle idempotent requests
 * This ensures that repeated requests with the same idempotency key
 * will produce the same result without executing the operation twice
 */
export const idempotency =
  (options: IdempotencyOptions = {}): RequestHandler =>
  async (req, res, next) => {
    const { enforceKey = false, methods = ['POST', 'PUT', 'PATCH', 'DELETE'] } = options;

    // Skip idempotency check for methods that don't modify state
    if (!methods.includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] as string;

    if (!idempotencyKey && enforceKey) {
      return next(new BadRequestError(`${IDEMPOTENCY_KEY_HEADER} header is required for this request`));
    }

    if (!idempotencyKey) {
      return next();
    }

    // Validate the idempotency key format (UUID v4)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return next(new BadRequestError(`Invalid ${IDEMPOTENCY_KEY_HEADER} format. Must be a valid UUID v4`));
    }

    const userId = req.user?.id || 'anonymous';
    const cacheKey = `idempotency:${userId}:${idempotencyKey}`;

    try {
      const cachedResponse = await cacheService.get(
        { key: cacheKey },
        { db: { caches: cacheRepository }, schema: z.string() }
      );

      if (cachedResponse) {
        const response = JSON.parse(cachedResponse) as CachedResponse;

        for (const [header, value] of Object.entries(response.headers)) {
          res.setHeader(header, value);
        }

        res.setHeader('X-Idempotency-Cache', 'HIT');

        return res.status(response.statusCode).json(response.body);
      }

      // No cached response - proceed and capture the response to cache after processing.
      res.setHeader('X-Idempotency-Cache', 'MISS');

      const originalJson = res.json.bind(res);

      // Override res.json to capture the response before sending it.
      res.json = function (body) {
        const responseData: CachedResponse = {
          statusCode: res.statusCode,
          body: body,
          headers: {},
        };

        const headerNames = ['content-type', 'etag'];
        for (const name of headerNames) {
          const headerValue = res.getHeader(name);
          if (headerValue) {
            responseData.headers[name] = headerValue.toString();
          }
        }

        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cacheService
            .set(
              {
                key: cacheKey,
                value: JSON.stringify(responseData),
                ttl: IDEMPOTENCY_TTL,
              },
              { db: { caches: cacheRepository } }
            )
            .catch(err => {
              req.logger.warn('Failed to cache idempotent response', {
                error: err.message,
                cacheKey,
                path: req.path,
                method: req.method,
                userId,
              });
            });
        }

        return originalJson(body);
      };

      next();
    } catch (error) {
      req.logger.error('Error in idempotency middleware', { error });
      next(error);
    }
  };

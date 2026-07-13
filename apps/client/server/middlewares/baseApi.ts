import { authMiddleware, auth } from '@server/auth/auth';
import { registerToolGearObserver } from '@server/services/gears/toolGearObserver';
import { logging } from '@server/middlewares/logging';
import errorHandler from '@server/middlewares/errorHandler';
import { apiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { apiKeyAnomalyDetection } from '@server/middlewares/apiKeyAnomalyDetection';
import { apiKeyRateLimit } from '@server/middlewares/apiKeyRateLimit';
import { analyticsMiddleware } from '@server/analytics/analyticsMiddleware';
import { connectDB } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { Request, Response } from 'express';
import nc from 'next-connect';
import { Config, isDevelopment } from '@server/utils/config';

// Gears: hook the shared tool pipeline once per lambda (fire-and-forget observer).
registerToolGearObserver();

interface BaseAPIOptions {
  auth: boolean;
  /** Maximum request body size in bytes (default: 1MB) */
  maxBodySize: number;
  /**
   * API-key scopes this route requires. When set, an API-key caller must hold
   * *at least one* of these scopes (OR semantics) or the request is rejected
   * with 403. Omit (default) to leave the route scope-less - any valid key is
   * authorized, exactly as before. JWT/browser callers are never affected: the
   * scope gate only runs for requests authenticated by an API key.
   */
  requiredScopes?: ApiKeyScope[];
}

/** Default max body size: 1MB - prevents memory exhaustion from large payloads */
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

// Module-scope = per Lambda container. True only for the first request a container serves,
// so CloudWatch can isolate cold-container latency from warm reuse.
let isFirstInvocation = true;

export function baseApi<Req extends Request = Request, Res extends Response = Response>(
  options: Partial<BaseAPIOptions> = {}
) {
  const resolvedOptions: BaseAPIOptions = {
    auth: true,
    maxBodySize: DEFAULT_MAX_BODY_SIZE,
    ...options,
  };

  const router = nc<Req, Res>({
    onError: errorHandler,
  });

  // Add req.logger early in the middleware chain, so subsequent
  // middlewares can take advantage of it.
  router.use(logging);

  // Emit one req-timing line per request (prod only): total time, DB-connect time, and whether
  // this was the container's cold first request. Lets cold-open latency be measured/attributed
  // in CloudWatch. `connectMs` is set by the connectDB middleware below.
  router.use((req, res, next) => {
    if (isDevelopment()) return next();
    const start = Date.now();
    const containerCold = isFirstInvocation;
    isFirstInvocation = false;
    // 'finish' fires on a clean response; 'close' fires if the client disconnects (or the socket
    // is destroyed) before that. Listen for both so an aborted/errored request still emits - a
    // single guard keeps it to one line, since 'finish' is followed by 'close' on a normal response.
    let logged = false;
    const emit = () => {
      if (logged) return;
      logged = true;
      req.logger
        .withMetadata({
          totalMs: Date.now() - start,
          connectMs: req.__connectMs ?? null,
          containerCold,
          aborted: !res.writableEnded, // true when the response never completed cleanly
        })
        .info('req-timing');
    };
    res.on('finish', emit);
    res.on('close', emit);
    next();
  });

  // Check request body size to prevent memory exhaustion
  router.use((req, res, next) => {
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > resolvedOptions.maxBodySize) {
      return res.status(413).json({
        error: 'Request entity too large',
        maxSize: resolvedOptions.maxBodySize,
        request_id: req.requestId,
      });
    }
    next();
  });

  // Connect to the database. Timed so req-timing can attribute the cold-container Mongo
  // connect cost (~0ms when the connection is reused on a warm container).
  router.use(async (req, res, next) => {
    const connectStart = Date.now();
    try {
      await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), req.logger);
    } finally {
      // Record the duration even when connectDB throws (exhausted retries), so the slow-failure
      // path still shows up in req-timing instead of as a null. Rethrow is preserved.
      req.__connectMs = Date.now() - connectStart;
    }

    next();
  });

  for (const middleware of authMiddleware) {
    router.use(middleware);
  }

  if (resolvedOptions.auth) {
    // Check API key authentication FIRST, before JWT
    // This allows API keys to work independently without requiring JWT/SST setup.
    // requiredScopes (when set) makes an under-scoped key 403 here instead of authorizing.
    router.use(apiKeyAuth(resolvedOptions.requiredScopes));

    // Detect anomalies in API key usage (runs after apiKeyAuth, before handler)
    // This runs asynchronously and doesn't block requests
    router.use(apiKeyAnomalyDetection());

    // Enforce per-API-key rate limits (skips non-API-key requests)
    router.use(apiKeyRateLimit());

    // Apply JWT authentication middleware (will be skipped if already authenticated via API key)
    router.use(auth);

    // Fire-and-forget analytics: ≤1 emit/user/UTC-day per Lambda instance (best-effort).
    // Gates on human JWT only; no-op when B4M_ANALYTICS_ENABLED is false or secrets unset.
    router.use(analyticsMiddleware());
  }

  // TODO: idempotency middleware disabled - it was creating a lot of idempotency keys in local
  // storage, causing localStorage quota exceeded errors. Needs a permanent fix before re-enabling.
  // router.use(idempotency());

  router.use(async (req, res, next) => {
    if (!isDevelopment()) {
      req.logger.info(`API Request: ${req.method} ${req.url}`);
    }
    next();
  });

  return router;
}

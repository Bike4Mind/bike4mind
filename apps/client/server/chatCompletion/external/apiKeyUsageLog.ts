import type { Request, Response } from 'express';
import type { ApiKeyCompletionSource } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { ApiKeyUsageManager } from '@bike4mind/server-utils/managers/apiKeyUsageManager';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import type { ApiKeyInfo } from '@server/cli/auth';
import { resolveApiKeyOwnerType } from '@server/utils/resolveApiKeyOwnerType';

// Non-standard status for a client that closed the connection before any response was sent.
const CLIENT_CLOSED_REQUEST = 499;

interface LogApiKeyUsageOnResponseParams {
  req: Request;
  res: Response;
  apiKey: ApiKeyInfo;
  endpoint: string;
  source: ApiKeyCompletionSource;
  startTime: number;
  logger: Logger;
  track: (p: Promise<void>) => void;
}

/**
 * Logs one API key usage row when the response finishes or the client disconnects. The write is
 * registered with `track` up front so the SIGTERM drain waits for it.
 */
export function logApiKeyUsageOnResponse({
  req,
  res,
  apiKey,
  endpoint,
  source,
  startTime,
  logger,
  track,
}: LogApiKeyUsageOnResponseParams): void {
  track(
    new Promise<void>(resolve => {
      let logged = false;
      const handler = () => {
        res.off('finish', handler);
        res.off('close', handler);
        if (logged) return;
        logged = true;
        void ApiKeyUsageManager.logUsage({
          keyId: apiKey.keyId,
          userId: apiKey.userId,
          ipAddress: getClientIp(req),
          endpoint,
          method: req.method,
          responseTime: Date.now() - startTime,
          statusCode: res.headersSent ? res.statusCode : CLIENT_CLOSED_REQUEST,
          source,
          ownerType: resolveApiKeyOwnerType(apiKey),
          logger,
        }).finally(resolve);
      };
      res.once('finish', handler);
      res.once('close', handler);
      if (res.destroyed || res.writableFinished) handler();
    })
  );
}

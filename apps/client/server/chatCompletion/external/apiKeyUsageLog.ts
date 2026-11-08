import type { Request, Response } from 'express';
import {
  apiCompletionObservationSchema,
  type ApiCompletionOutcome,
  type ApiKeyCompletionSource,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { ApiKeyUsageManager } from '@bike4mind/server-utils/managers/apiKeyUsageManager';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import type { ApiKeyInfo } from '@server/cli/auth';
import { resolveApiKeyOwnerType } from '@server/utils/resolveApiKeyOwnerType';

const CLIENT_CLOSED_REQUEST = 499;

type LogApiKeyUsageOnResponseParams = {
  req: Request;
  res: Response;
  apiKey: ApiKeyInfo;
  endpoint: string;
  source: ApiKeyCompletionSource;
  startTime: number;
  completion?: { requestId: string; requestedModel: string; outcome: () => ApiCompletionOutcome };
  logger: Logger;
  track: (promise: Promise<void>) => void;
};

/** Persists an authenticated start before execution, then updates it on finish or disconnect. */
export function logApiKeyUsageOnResponse({
  req,
  res,
  apiKey,
  endpoint,
  source,
  startTime,
  logger,
  track,
  completion,
}: LogApiKeyUsageOnResponseParams): Promise<void> {
  const metadata = completion
    ? apiCompletionObservationSchema.safeParse({
        requestId: completion.requestId,
        requestedModel: completion.requestedModel,
        startedAt: new Date(startTime).toISOString(),
        outcome: 'unknown',
      })
    : null;
  if (metadata && !metadata.success) logger.warn('Completion request metadata was invalid');
  const captured = metadata?.success ? metadata.data : undefined;
  const identity = {
    keyId: apiKey.keyId,
    userId: apiKey.userId,
    ipAddress: getClientIp(req),
    endpoint,
    method: req.method,
    source,
    ownerType: resolveApiKeyOwnerType(apiKey),
    logger,
  };
  const started = captured
    ? ApiKeyUsageManager.beginCompletionUsage({
        ...identity,
        responseTime: 0,
        statusCode: 0,
        completionObservation: captured,
      })
    : Promise.resolve(null);
  const ready = started.then(() => undefined);
  track(ready);
  track(
    new Promise<void>(resolve => {
      let logged = false;
      const handler = () => {
        res.off('finish', handler);
        res.off('close', handler);
        if (logged) return;
        logged = true;
        const observed = completion?.outcome() ?? 'unknown';
        const completionObservation = captured
          ? {
              ...captured,
              outcome: observed === 'unknown' && !res.writableFinished ? ('interrupted' as const) : observed,
            }
          : undefined;
        const statusCode = res.headersSent ? res.statusCode : CLIENT_CLOSED_REQUEST;
        if (completionObservation)
          logger.info('API completion request outcome', {
            requestId: completionObservation.requestId,
            userId: apiKey.userId,
            endpoint,
            outcome: completionObservation.outcome,
            statusCode,
          });
        void started
          .then(existingLogId => {
            // A missing start may mean account purge; never recreate it from a late response.
            if (captured && !existingLogId) return;
            return ApiKeyUsageManager.logUsage({
              ...identity,
              responseTime: Date.now() - startTime,
              statusCode,
              ...(existingLogId ? { existingLogId } : {}),
              ...(completionObservation ? { completionObservation } : {}),
            });
          })
          .catch(error =>
            logger.warn('Completion outcome logging failed', {
              errorName: error instanceof Error ? error.name : typeof error,
            })
          )
          .finally(resolve);
      };
      res.once('finish', handler);
      res.once('close', handler);
      if (res.destroyed || res.writableFinished) handler();
    })
  );
  return ready;
}

import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import type { NextApiHandler } from 'next';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { LEGACY_REQUEST_ID_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@bike4mind/common';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';

// Makes static Logger.* calls resolve to the current request's logger instead of the process-wide one.
const requestLoggerStore = new AsyncLocalStorage<Logger>();
Logger.setContextProvider(() => requestLoggerStore.getStore());

export function createRequestLogger(req: IncomingMessage, { requestId, path }: { requestId: string; path: string }) {
  // Preserve the AWS X-Ray trace ID under a separate key so anyone correlating
  // CloudWatch logs to X-Ray spans still has an entry point. The trace ID is
  // injected by API Gateway / Lambda and is independent of the caller's
  // X-Request-ID.
  const traceId = typeof req.headers['x-amzn-trace-id'] === 'string' ? req.headers['x-amzn-trace-id'] : undefined;

  return new Logger({
    metadata: {
      requestId,
      ...(traceId && { traceId }),
      method: req.method,
      path,
      stage: Config.STAGE,
      // Shared resolver, not the raw spoofable leftmost x-forwarded-for value.
      clientIp: getClientIp(req),
    },
  });
}

export function runWithRequestLogger<T>(logger: Logger, fn: () => T): T {
  return requestLoggerStore.run(logger, fn);
}

/** For handlers that do not go through baseApi; the context covers work that continues after the response is sent. */
export function withRequestLogger(handler: NextApiHandler): NextApiHandler {
  return (req, res) => {
    const requestId = resolveRequestId(
      req.headers[REQUEST_ID_HEADER.toLowerCase()],
      req.headers[LEGACY_REQUEST_ID_HEADER.toLowerCase()]
    );
    const path = (req.url ?? '').split('?')[0];
    return runWithRequestLogger(createRequestLogger(req, { requestId, path }), () => handler(req, res));
  };
}

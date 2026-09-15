import { RequestHandler } from 'express';
import { Logger } from '@bike4mind/observability';
import { invert } from 'lodash';
import { Config } from '@server/utils/config';
import { LEGACY_REQUEST_ID_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@bike4mind/common';
import { getClientIp } from '@server/utils/ip';

export const logging: RequestHandler = (req, res, next) => {
  // TODO: This bit assumes that each function handler is only handling
  //   one request at a time (no concurrency within a handler).  That's
  //   true currently, but long-term, may not be.  As such, this code
  //   updates the global instance as well (via `Logger.updateMetadata()`),
  //   but we'd ultimately like to move away from global state, so this
  //   should move toward `new Logger().withMetadata()` instead.
  // Use the shared resolver instead of the raw, spoofable leftmost
  // x-forwarded-for value so log lines record the real client IP.
  const clientIp = getClientIp(req);
  const invertedParams = invert(req.query ?? {});
  req.baseUrl ??= req.url
    .split('/')
    .map(v => (invertedParams[v] ? `:${invertedParams[v]}` : v))
    .join('/');
  // Correlation ID - accept the caller's value (sanitized) or generate one,
  // then echo it back so callers can correlate a failure with our logs.
  req.requestId = resolveRequestId(
    req.headers[REQUEST_ID_HEADER.toLowerCase()],
    req.headers[LEGACY_REQUEST_ID_HEADER.toLowerCase()]
  );
  res.setHeader(REQUEST_ID_HEADER, req.requestId);

  // Preserve the AWS X-Ray trace ID under a separate key so anyone correlating
  // CloudWatch logs to X-Ray spans still has an entry point. The trace ID is
  // injected by API Gateway / Lambda and is independent of the caller's
  // X-Request-ID.
  const traceId = typeof req.headers['x-amzn-trace-id'] === 'string' ? req.headers['x-amzn-trace-id'] : undefined;

  req.logger = Logger.resetMetadata().updateMetadata({
    requestId: req.requestId,
    ...(traceId && { traceId }),
    method: req.method,
    path: req.baseUrl,
    stage: Config.STAGE,
    clientIp,
  });
  next();
};

import { RequestHandler } from 'express';
import invert from 'lodash/invert';
import { LEGACY_REQUEST_ID_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@bike4mind/common';
import { createRequestLogger, runWithRequestLogger } from './requestLogger';

export const logging: RequestHandler = (req, res, next) => {
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

  req.logger = createRequestLogger(req, { requestId: req.requestId, path: req.baseUrl });
  runWithRequestLogger(req.logger, next);
};

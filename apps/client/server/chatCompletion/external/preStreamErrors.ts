import {
  BadRequestError,
  HTTPError,
  LEGACY_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  UnprocessableEntityError,
  isSpendFrozenError,
  resolveRequestId,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { resolveQuestErrorCode } from '@bike4mind/services/llm';
import { flattenHeaders } from '@bike4mind/server-utils/utils/flattenHeaders';
import { serializeError } from '@bike4mind/server-utils/utils/serializeError';
import { getHttpStatus } from '@bike4mind/utils';
import { buildErrorBody, httpErrorToResponse } from '@server/middlewares/errorHandler';
import type { NextFunction, Request, Response } from 'express';

/**
 * The pre-stream error handling the public ChatCompletion SSE routes share (sseRoute.ts and
 * turnsRoute.ts): request ids, the JSON error envelope for a failure found before the stream opens,
 * and the body parser's failures.
 */

const UPSTREAM_CALLER_ERROR_STATUSES = new Set([400, 404, 413, 422]);
// Model availability, provider credentials and provider credit are deployment faults even
// when the provider reports 400/404. Keep their diagnostics and operator-failure metric.
const OPERATOR_SIDE_4XX_PATTERNS = [
  /no longer available/i,
  /is not available/i,
  /does not exist or you do not have access/i,
  /\bmodel\s+[`'"]?[\w./:-]+[`'"]?\s+does not exist\b/i,
  /model not (?:found|available)/i,
  /model identifier is invalid/i,
  /api key (?:not valid|is invalid|has expired|is missing)/i,
  /invalid api key/i,
  /credit balance/i,
  // Anthropic's org spend cap; keep in sync with isProviderSpendLimitError (@bike4mind/utils).
  /reached your specified api usage limits/i,
];

export function isUpstreamCallerError(error: unknown): error is Error {
  if (!(error instanceof Error) || error instanceof HTTPError) return false;
  if (!UPSTREAM_CALLER_ERROR_STATUSES.has(getHttpStatus(error) ?? 0)) return false;
  return !OPERATOR_SIDE_4XX_PATTERNS.some(pattern => pattern.test(error.message));
}

export function requestIdFrom(headers: Record<string, string | undefined>): string {
  return resolveRequestId(headers[REQUEST_ID_HEADER.toLowerCase()], headers[LEGACY_REQUEST_ID_HEADER.toLowerCase()]);
}

/** A failure caught before onReady: the JSON envelope, with the status its thrower chose. */
export function toJsonError(
  error: unknown,
  requestId: string
): { status: number; headers: Record<string, string>; body: Record<string, unknown> } {
  // A freeze is a 403 with its scope, not the 422 every other quest code maps to.
  if (isSpendFrozenError(error)) return httpErrorToResponse(error, requestId);
  const questCode = resolveQuestErrorCode(error);
  if (questCode) {
    const message = error instanceof Error ? error.message : 'Insufficient credits';
    return httpErrorToResponse(new UnprocessableEntityError(message, { errorCode: questCode }), requestId);
  }
  if (error instanceof HTTPError) return httpErrorToResponse(error, requestId);
  if (isUpstreamCallerError(error)) {
    return httpErrorToResponse(
      new BadRequestError('The model provider rejected the request', { errorCode: 'invalid_request' }),
      requestId
    );
  }
  return { status: 500, headers: {}, body: buildErrorBody({ error: 'Internal error', requestId }) };
}

/**
 * express.json failures never reach the handler. 415 (unsupported charset or encoding) is outside
 * the contract's status table, so every client fault but an oversized body folds into 400.
 */
export function handleBodyParserError(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  const requestId = requestIdFrom(flattenHeaders(req.headers));
  const parserStatus = err instanceof Error ? getHttpStatus(err) : undefined;
  if (parserStatus === undefined || parserStatus < 400 || parserStatus >= 500) {
    new Logger({ metadata: { service: 'chatCompletion', endpoint: req.path, requestId } }).error(
      '[CLI_LLM] Body parser error',
      { requestId, error: serializeError(err) }
    );
    res
      .status(500)
      .set(REQUEST_ID_HEADER, requestId)
      .json(buildErrorBody({ error: 'Internal error', requestId }));
    return;
  }
  const type = (err as { type?: unknown }).type;
  const status = type === 'entity.too.large' ? 413 : 400;
  const message = err instanceof Error && err.message ? err.message : 'Invalid request body';
  res
    .status(status)
    .set(REQUEST_ID_HEADER, requestId)
    .json(buildErrorBody({ error: message, requestId }));
}

import { HTTPError, HttpStatus, NotFoundError, UnprocessableEntityError, isZodError } from '@bike4mind/common';
import { Request, Response } from 'express';
import { fromZodError } from 'zod-validation-error';

const errorHandler = (error: unknown, req: Request, res: Response) => {
  let additionalInfo: Record<string, unknown> | undefined;
  let statusCode = HttpStatus.InternalServerError;

  if (typeof error === 'object' && error !== null && 'name' in error) {
    let errorObj = error as { name: string; message?: string };

    // Only a cast on `_id` means the caller handed us a junk resource id, which is a
    // genuine 404. A CastError raised anywhere else (a side effect, a non-lookup field)
    // is a server-side bug and must stay a 5xx so it is logged at `error` and alarms.
    if (errorObj.name === 'CastError' && (errorObj as { path?: string }).path === '_id') {
      errorObj = new NotFoundError('Resource not found');
    }

    if (isZodError(error)) {
      errorObj = new UnprocessableEntityError(fromZodError(error).message);
    }

    if (errorObj instanceof HTTPError) {
      ({ statusCode } = errorObj);
      additionalInfo = errorObj.additionalInfo;
    } else if ('status' in error && typeof (error as Record<string, unknown>).status === 'number') {
      statusCode = (error as Record<string, unknown>).status as number;
    }

    // 4xx = client error (expected in normal operation) -> warn
    // 5xx = server error (actual bug/outage) -> error (triggers LiveOps via CloudWatch filter)
    const message = `${req.method} ${req.url} → ${statusCode}: ${errorObj.message || 'No message available'}`;
    if (statusCode >= 500) {
      req.logger.error(message, error);
    } else {
      req.logger.warn(message);
    }

    res.status(statusCode).json({
      ...additionalInfo,
      // Deprecated, remove on 2026-12-01 along with `name` in ApiErrorSchema /
      // ErrorResponse. It leaks the thrower's class name onto a public wire and it
      // shadows any `name` an endpoint put in additionalInfo. Documented in the
      // envelope only for the deprecation window; see CONVENTIONS.md section 1.
      name: errorObj.name,
      error: errorObj.message || 'Server Error',
      request_id: req.requestId,
    });
    return;
  }

  // Unknown error shape - treat as server error
  req.logger.error(`${req.method} ${req.url} → ${statusCode}: Unknown error`, error);
  res.status(statusCode).json({
    error: 'An unknown error occurred',
    request_id: req.requestId,
  });
  return;
};

export default errorHandler;

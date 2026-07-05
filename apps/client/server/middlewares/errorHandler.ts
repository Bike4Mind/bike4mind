import { HTTPError, HttpStatus, NotFoundError, UnprocessableEntityError, isZodError } from '@bike4mind/common';
import { Request, Response } from 'express';
import { fromZodError } from 'zod-validation-error';

const errorHandler = (error: unknown, req: Request, res: Response) => {
  let additionalInfo: Record<string, unknown> | undefined;
  let statusCode = HttpStatus.InternalServerError;

  if (typeof error === 'object' && error !== null && 'name' in error) {
    let errorObj = error as { name: string; message?: string };

    if (errorObj.name === 'CastError') {
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

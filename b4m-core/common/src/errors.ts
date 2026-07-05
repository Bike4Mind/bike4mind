import { ZodError } from 'zod';

// ---------- HTTP errors (canonical location) ----------

export enum HttpStatus {
  Ok = 200,
  Created = 201,
  BadRequest = 400,
  Unauthorized = 401,
  Forbidden = 403,
  NotFound = 404,
  UnprocessableEntity = 422,
  TooManyRequests = 429,
  InternalServerError = 500,
}

export class HTTPError extends Error {
  constructor(
    public statusCode: number,
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'HTTPError';
  }
}

export class InternalServerError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.InternalServerError, message, additionalInfo);
    this.name = 'InternalServerError';
  }
}

export class NotFoundError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.NotFound, message, additionalInfo);
    this.name = 'NotFoundError';
  }
}

export class UnprocessableEntityError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.UnprocessableEntity, message, additionalInfo);
    this.name = 'UnprocessableEntityError';
  }
}

export class BadRequestError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.BadRequest, message, additionalInfo);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.Unauthorized, message, additionalInfo);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.Forbidden, message, additionalInfo);
    this.name = 'ForbiddenError';
  }
}

export class TooManyRequestsError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.TooManyRequests, message, additionalInfo);
    this.name = 'TooManyRequestsError';
  }
}

export class CorruptedFileError extends HTTPError {
  constructor(
    fileName: string,
    fileType: string,
    corruptionDetails?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    const message = `File '${fileName}' (${fileType}) appears to be corrupted${corruptionDetails ? `: ${corruptionDetails}` : ''}. Please try uploading the file again.`;
    super(HttpStatus.UnprocessableEntity, message, additionalInfo);
    this.name = 'CorruptedFileError';
  }
}

export function isZodError(err: unknown): err is ZodError {
  return Boolean(err && (err instanceof ZodError || (err as ZodError).name === 'ZodError'));
}

// ---------- MCP permission errors ----------

/**
 * Error thrown when user denies permission for a tool.
 * This should break the agent loop immediately and return control to the user.
 */
export class PermissionDeniedError extends Error {
  constructor(
    public toolName: string,
    public toolArgs?: unknown
  ) {
    super(`Permission denied for tool: ${toolName}`);
    this.name = 'PermissionDeniedError';
  }
}

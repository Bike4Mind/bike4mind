import { ZodError } from 'zod';
import type { IFabFileDocument } from './types/entities/FabFileTypes';

// ---------- HTTP errors (canonical location) ----------

export enum HttpStatus {
  Ok = 200,
  Created = 201,
  BadRequest = 400,
  Unauthorized = 401,
  Forbidden = 403,
  NotFound = 404,
  Conflict = 409,
  UnprocessableEntity = 422,
  TooManyRequests = 429,
  InternalServerError = 500,
  BadGateway = 502,
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

/** 409: the request conflicts with current state - e.g. a per-user concurrency cap. */
export class ConflictError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.Conflict, message, additionalInfo);
    this.name = 'ConflictError';
  }
}

/** 502: an upstream we depend on failed. The caller's request was well-formed. */
export class BadGatewayError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.BadGateway, message, additionalInfo);
    this.name = 'BadGatewayError';
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

/**
 * Thrown by `chunkFabfile`'s guarded-write ownership check (#1802): the run's claim stamp no longer
 * matches `FabFile.chunkClaimedAt`, meaning a stale-claim takeover already reassigned this file to a
 * successor mid-run. Not a failure - the successor is doing the work. Deliberately NOT an HTTPError:
 * this is an internal worker control-flow signal, not an API response shape. Callers must treat it as
 * a benign no-op (no retry, no failure/DLQ accounting) - see `isTransientTransactionError`, which this
 * does not match, and the queue handler's catch in `fabFileChunk.ts`.
 */
export class ChunkClaimLostError extends Error {
  constructor(public fabFileId: string) {
    super(`Chunk claim for FabFile ${fabFileId} was lost to a successor mid-run`);
    this.name = 'ChunkClaimLostError';
  }
}

/**
 * `ChunkClaimLostError` is thrown in `@bike4mind/services` and caught in `apps/client` - a bare
 * `instanceof` across that package boundary breaks if `@bike4mind/common` is ever resolved as two
 * distinct module realms (mirrors `isZodError` below, same reason). A miss here would silently
 * misroute every lost-claim case into the failure/DLQ path.
 */
export function isChunkClaimLostError(err: unknown): err is ChunkClaimLostError {
  return Boolean(err && (err instanceof ChunkClaimLostError || (err as Error).name === 'ChunkClaimLostError'));
}

export function isZodError(err: unknown): err is ZodError {
  return Boolean(err && (err instanceof ZodError || (err as ZodError).name === 'ZodError'));
}

/**
 * Thrown by `createFabFileByUrl` (`@bike4mind/services`) when the adapter-supplied `checkDuplicate`
 * finds a live match for the fetched content's hash, BEFORE any row is created - so a caller that
 * dedupes never strands a row the way a create-then-check ordering would. A thrown error rather
 * than a changed return type: every other caller (the web URL door, the proposal-admission door)
 * never supplies `checkDuplicate` and so can never see this thrown, keeping their contract exactly
 * as it was before this existed. Lives here (not in `@bike4mind/services`) for the same reason
 * `ChunkClaimLostError` does: thrown in one package, caught in another, so it needs one canonical
 * module identity rather than a per-caller `instanceof` that can miss across module realms.
 */
export class DuplicateFabFileError extends Error {
  constructor(
    /** The already-live FabFile this fetch's content hash matches. */
    public readonly existing: IFabFileDocument,
    /** The title resolved for THIS attempt - what the caller should name the skip. */
    public readonly fetchedTitle: string
  ) {
    // Generic on purpose: this class is thrown for ANY `checkDuplicate` caller, not only the Slack
    // data-lake path - a "data lake" specific message here would misdescribe a future caller that
    // dedupes against something else. Callers that need lake-specific wording build it themselves
    // (see `dataLakeLinkIngest.ts`'s catch, which never reads this message).
    super('Duplicate content already exists');
    this.name = 'DuplicateFabFileError';
  }
}

/**
 * Same cross-package-boundary concern as `isChunkClaimLostError` above: a bare `instanceof` against
 * `DuplicateFabFileError` can miss if `@bike4mind/common` is ever resolved as two distinct module
 * realms. Falls back to `.name`, which the constructor above always sets.
 */
export function isDuplicateFabFileError(err: unknown): err is DuplicateFabFileError {
  return Boolean(err && (err instanceof DuplicateFabFileError || (err as Error).name === 'DuplicateFabFileError'));
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

import { z, ZodError } from 'zod';
import type { ApiErrorCode } from './apiErrorCodes';
import type { IFabFileDocument } from './types/entities/FabFileTypes';

// ---------- HTTP errors (canonical location) ----------

export enum HttpStatus {
  Ok = 200,
  Created = 201,
  BadRequest = 400,
  Unauthorized = 401,
  Forbidden = 403,
  NotFound = 404,
  MethodNotAllowed = 405,
  Conflict = 409,
  UnprocessableEntity = 422,
  TooManyRequests = 429,
  InternalServerError = 500,
  BadGateway = 502,
  ServiceUnavailable = 503,
  GatewayTimeout = 504,
}

export class HTTPError extends Error {
  /**
   * Set on a 5xx that reports a third party's failure the server handled correctly (a source site
   * timing out), so `errorHandler` logs it at warn rather than paging as a server fault.
   */
  public expected?: boolean;

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

/** Narrows API_ERROR_CODES to the storage refusals (CONVENTIONS.md section 1). */
export const STORAGE_ERROR_CODES = [
  'storage_limit_exceeded',
  'org_storage_limit_exceeded',
  'file_too_large',
] as const satisfies readonly ApiErrorCode[];
export const StorageErrorCodeSchema = z.enum(STORAGE_ERROR_CODES);
export type StorageErrorCode = z.infer<typeof StorageErrorCodeSchema>;

/**
 * Machine-readable detail of a storage refusal, spread into the error body by errorHandler. Branch on
 * `errorCode`, never on the human message. `used_bytes` is the user's cumulative usage for a user quota
 * refusal and 0 for the per-file ceilings (organizations track no cumulative usage, and the file-size
 * cap has none), so `limit_bytes` is the cap that `requested_bytes` ran into in every case.
 */
export const StorageLimitErrorInfoSchema = z.object({
  errorCode: StorageErrorCodeSchema.describe(
    'Stable refusal code: `storage_limit_exceeded` (your total storage), `org_storage_limit_exceeded` (the organization limit), or `file_too_large` (the per-file size limit). Branch on this, not on the message.'
  ),
  used_bytes: z
    .number()
    .nonnegative()
    .describe('Bytes already stored against the limit. 0 for `org_storage_limit_exceeded` and `file_too_large`.'),
  limit_bytes: z.number().nonnegative().describe('The limit, in bytes, that the request ran into.'),
  requested_bytes: z.number().nonnegative().describe('Size of the refused upload, in bytes.'),
  owner: z
    .enum(['user', 'org'])
    .describe('Whose limit was hit: `user` or `org`. Always `user` for `file_too_large`, a platform-wide cap.'),
});
export type StorageLimitErrorInfo = z.infer<typeof StorageLimitErrorInfoSchema>;

/** 400 for a quota or per-file size refusal; the status stays 400 so existing clients keep working. */
export class StorageLimitError extends BadRequestError {
  constructor(
    message: string,
    public readonly info: StorageLimitErrorInfo
  ) {
    super(message, info);
    this.name = 'StorageLimitError';
  }
}

/** Name fallback for the same cross-module-realm reason as `isConcurrencyConflictError`. */
export function isStorageLimitError(err: unknown): err is StorageLimitError {
  return Boolean(
    err instanceof StorageLimitError ||
    (err instanceof Error &&
      err.name === 'StorageLimitError' &&
      StorageLimitErrorInfoSchema.safeParse((err as { info?: unknown }).info).success)
  );
}

/** The storage detail on an error response body, or undefined when the body carries none. */
export function parseStorageLimitErrorInfo(body: unknown): StorageLimitErrorInfo | undefined {
  const parsed = StorageLimitErrorInfoSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The one user-facing wording for a storage refusal, built from the numbers so rewording the thrown message
 * cannot change it. The caller supplies the byte formatter so the app's own units stay the single source.
 */
export function describeStorageLimitError(info: StorageLimitErrorInfo, formatBytes: (bytes: number) => string): string {
  const { errorCode, used_bytes, limit_bytes, requested_bytes } = info;
  switch (errorCode) {
    case 'storage_limit_exceeded': {
      const bytesToFree = used_bytes + requested_bytes - limit_bytes;
      return (
        `Not enough storage: you are using ${formatBytes(used_bytes)} of ${formatBytes(limit_bytes)}, ` +
        `and this upload needs ${formatBytes(requested_bytes)}. Free up at least ${formatBytes(bytesToFree)} to continue.`
      );
    }
    case 'org_storage_limit_exceeded':
      return `This upload (${formatBytes(requested_bytes)}) is larger than your organization's storage limit of ${formatBytes(limit_bytes)}.`;
    case 'file_too_large':
      return `This file (${formatBytes(requested_bytes)}) is larger than the maximum file size of ${formatBytes(limit_bytes)}.`;
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

/** 405: the route exists but does not serve this HTTP method. Set an `Allow` header before throwing. */
export class MethodNotAllowedError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.MethodNotAllowed, message, additionalInfo);
    this.name = 'MethodNotAllowedError';
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

/**
 * Thrown by `BaseRepository.updateGuarded` when a version-guarded write matches no document because a
 * concurrent writer advanced the doc's `__v` since this caller read it - a lost optimistic-concurrency
 * race. Extends ConflictError so an uncaught one surfaces as a retryable 409 rather than a 500; a
 * caller that can re-read and re-apply should catch it. Uses the `.name` fallback guard below for the
 * same cross-module-realm reason as `isChunkClaimLostError`.
 */
export class ConcurrencyConflictError extends ConflictError {
  constructor(
    public readonly modelName: string,
    additionalInfo?: Record<string, unknown>
  ) {
    super(`Concurrent modification of ${modelName}: the document changed since it was read`, additionalInfo);
    this.name = 'ConcurrencyConflictError';
  }
}

export function isConcurrencyConflictError(err: unknown): err is ConcurrencyConflictError {
  return Boolean(
    err && (err instanceof ConcurrencyConflictError || (err as Error).name === 'ConcurrencyConflictError')
  );
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

/** 504: an upstream we depend on did not answer in time. Retrying later may succeed. */
export class GatewayTimeoutError extends HTTPError {
  constructor(
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(HttpStatus.GatewayTimeout, message, additionalInfo);
    this.name = 'GatewayTimeoutError';
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

/**
 * Thrown by FabFile hard-delete methods when a file has moderationStatus 'blocked'.
 * Blocked files are legal-hold evidence (18 U.S.C. section 2258A) and must not be
 * destroyed. The data-lake sweep and purge callers catch this and skip the file instead
 * of re-throwing for DLQ retry.
 *
 * Lives in @bike4mind/common (not @bike4mind/database) because it is thrown in
 * packages/database and caught in b4m-core/services, which does not depend on the
 * database package. The isLegalHoldError guard handles any cross-realm instanceof edge.
 */
export class LegalHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegalHoldError';
  }
}

export function isLegalHoldError(err: unknown): err is LegalHoldError {
  return Boolean(err && (err instanceof LegalHoldError || (err as Error).name === 'LegalHoldError'));
}

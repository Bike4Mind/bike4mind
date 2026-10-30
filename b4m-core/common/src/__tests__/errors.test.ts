import { describe, it, expect } from 'vitest';
import {
  HttpStatus,
  HTTPError,
  InternalServerError,
  NotFoundError,
  UnprocessableEntityError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  TooManyRequestsError,
  CorruptedFileError,
  isZodError,
  PermissionDeniedError,
  ChunkClaimLostError,
  isChunkClaimLostError,
  DuplicateFabFileError,
  isDuplicateFabFileError,
  UrlBlockedError,
  isUrlBlockedError,
  StorageLimitError,
  describeStorageLimitError,
  isStorageLimitError,
  parseStorageLimitErrorInfo,
  redactStorageLimitError,
  type StorageLimitErrorInfo,
} from '../errors';

describe('HttpStatus enum', () => {
  it('has correct status codes', () => {
    expect(HttpStatus.Ok).toBe(200);
    expect(HttpStatus.BadRequest).toBe(400);
    expect(HttpStatus.NotFound).toBe(404);
    expect(HttpStatus.InternalServerError).toBe(500);
    expect(HttpStatus.TooManyRequests).toBe(429);
  });
});

describe('HTTP error classes', () => {
  it('HTTPError has correct statusCode and message', () => {
    const err = new HTTPError(418, 'teapot');
    expect(err.statusCode).toBe(418);
    expect(err.message).toBe('teapot');
    expect(err.name).toBe('HTTPError');
    expect(err).toBeInstanceOf(Error);
  });

  it('HTTPError supports additionalInfo', () => {
    const err = new HTTPError(400, 'bad', { field: 'email' });
    expect(err.additionalInfo).toEqual({ field: 'email' });
  });

  const cases: Array<[string, new (msg?: string) => HTTPError, number]> = [
    ['InternalServerError', InternalServerError, 500],
    ['NotFoundError', NotFoundError, 404],
    ['UnprocessableEntityError', UnprocessableEntityError, 422],
    ['BadRequestError', BadRequestError, 400],
    ['UnauthorizedError', UnauthorizedError, 401],
    ['ForbiddenError', ForbiddenError, 403],
    ['TooManyRequestsError', TooManyRequestsError, 429],
  ];

  it.each(cases)('%s has correct statusCode %i', (name, ErrorClass, expectedCode) => {
    const err = new ErrorClass('test message');
    expect(err.statusCode).toBe(expectedCode);
    expect(err.message).toBe('test message');
    expect(err.name).toBe(name);
    expect(err).toBeInstanceOf(HTTPError);
    expect(err).toBeInstanceOf(Error);
  });

  it('CorruptedFileError builds message from filename and type', () => {
    const err = new CorruptedFileError('photo.jpg', 'image/jpeg', 'header missing');
    expect(err.statusCode).toBe(HttpStatus.UnprocessableEntity);
    expect(err.message).toContain('photo.jpg');
    expect(err.message).toContain('image/jpeg');
    expect(err.message).toContain('header missing');
    expect(err.name).toBe('CorruptedFileError');
  });

  it('CorruptedFileError works without corruptionDetails', () => {
    const err = new CorruptedFileError('file.pdf', 'application/pdf');
    expect(err.message).toContain('file.pdf');
    expect(err.message).not.toContain(':');
  });
});

describe('isZodError', () => {
  it('returns false for non-zod errors', () => {
    expect(isZodError(new Error('nope'))).toBe(false);
    expect(isZodError(null)).toBe(false);
    expect(isZodError(undefined)).toBe(false);
    expect(isZodError('string')).toBe(false);
  });

  it('returns true for objects with name ZodError', () => {
    const fakeZod = { name: 'ZodError' };
    expect(isZodError(fakeZod)).toBe(true);
  });
});

describe('isUrlBlockedError', () => {
  it('returns true for a real UrlBlockedError, which is also a 400 BadRequestError', () => {
    const err = new UrlBlockedError('URL blocked for security reasons');
    expect(isUrlBlockedError(err)).toBe(true);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.statusCode).toBe(HttpStatus.BadRequest);
  });

  it('returns true for an error from another module realm that only carries the name', () => {
    expect(isUrlBlockedError(Object.assign(new BadRequestError('blocked'), { name: 'UrlBlockedError' }))).toBe(true);
  });

  it('returns false for a plain BadRequestError and for non-errors', () => {
    expect(isUrlBlockedError(new BadRequestError('Unsupported file type'))).toBe(false);
    expect(isUrlBlockedError(undefined)).toBe(false);
    expect(isUrlBlockedError(null)).toBe(false);
  });
});

describe('isChunkClaimLostError', () => {
  it('returns true for a real ChunkClaimLostError', () => {
    expect(isChunkClaimLostError(new ChunkClaimLostError('ff1'))).toBe(true);
  });

  // The `.name` arm is the point: `instanceof` fails if `@bike4mind/common` is ever resolved as
  // two module realms across a package boundary (e.g. services -> apps/client). Only this test
  // exercises the real dual-check - fabFileChunk.test.ts mocks this module and re-declares its own
  // copy of ChunkClaimLostError, so it never loads the real function.
  it('returns true for a same-named error from another module realm', () => {
    const crossRealm = Object.assign(new Error('cross-realm'), { name: 'ChunkClaimLostError' });
    expect(isChunkClaimLostError(crossRealm)).toBe(true);
  });

  it('returns false for unrelated errors and non-errors', () => {
    expect(isChunkClaimLostError(new Error('nope'))).toBe(false);
    expect(isChunkClaimLostError(null)).toBe(false);
    expect(isChunkClaimLostError(undefined)).toBe(false);
  });
});

describe('DuplicateFabFileError / isDuplicateFabFileError', () => {
  it('carries the matched existing file and the newly-fetched title', () => {
    const existing = { id: 'fab-1' } as never;
    const err = new DuplicateFabFileError(existing, 'A New Title');
    expect(err.existing).toBe(existing);
    expect(err.fetchedTitle).toBe('A New Title');
    expect(err.name).toBe('DuplicateFabFileError');
  });

  it('returns true for a real DuplicateFabFileError', () => {
    expect(isDuplicateFabFileError(new DuplicateFabFileError({} as never, 'x'))).toBe(true);
  });

  // Same cross-package-boundary concern as isChunkClaimLostError above (thrown in
  // @bike4mind/services, caught in apps/client) - only this test exercises the real dual-check.
  it('returns true for a same-named error from another module realm', () => {
    const crossRealm = Object.assign(new Error('cross-realm'), { name: 'DuplicateFabFileError' });
    expect(isDuplicateFabFileError(crossRealm)).toBe(true);
  });

  it('returns false for unrelated errors and non-errors', () => {
    expect(isDuplicateFabFileError(new Error('nope'))).toBe(false);
    expect(isDuplicateFabFileError(null)).toBe(false);
    expect(isDuplicateFabFileError(undefined)).toBe(false);
  });
});

describe('PermissionDeniedError', () => {
  it('has correct toolName and message', () => {
    const err = new PermissionDeniedError('web_search', { query: 'test' });
    expect(err.toolName).toBe('web_search');
    expect(err.toolArgs).toEqual({ query: 'test' });
    expect(err.message).toContain('web_search');
    expect(err.name).toBe('PermissionDeniedError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('StorageLimitError', () => {
  const info: StorageLimitErrorInfo = {
    errorCode: 'storage_limit_exceeded',
    used_bytes: 800_000,
    limit_bytes: 1_000_000,
    requested_bytes: 300_000,
    owner: 'user',
  };

  it('is a 400 BadRequestError that carries its info as additionalInfo', () => {
    const err = new StorageLimitError('whatever', info);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.statusCode).toBe(400);
    expect(err.additionalInfo).toEqual(info);
  });

  it('is recognised by class, and by name plus a valid info across a module boundary', () => {
    expect(isStorageLimitError(new StorageLimitError('x', info))).toBe(true);
    const foreign = Object.assign(new Error('x'), { name: 'StorageLimitError', info });
    expect(isStorageLimitError(foreign)).toBe(true);
  });

  it('rejects a lookalike without a valid info, and unrelated values', () => {
    expect(isStorageLimitError(Object.assign(new Error('x'), { name: 'StorageLimitError' }))).toBe(false);
    expect(
      isStorageLimitError(
        Object.assign(new Error('x'), { name: 'StorageLimitError', info: { ...info, errorCode: 'nope' } })
      )
    ).toBe(false);
    expect(isStorageLimitError(new BadRequestError('File size exceeds storage limit'))).toBe(false);
    expect(isStorageLimitError(null)).toBe(false);
  });

  it('parses a response body that carries the info and ignores the envelope around it', () => {
    expect(parseStorageLimitErrorInfo({ ...info, error: 'x', request_id: 'r' })).toEqual(info);
  });

  it('parses nothing from a body with an unknown code or negative bytes', () => {
    expect(parseStorageLimitErrorInfo({ ...info, errorCode: 'insufficient_credits' })).toBeUndefined();
    expect(parseStorageLimitErrorInfo({ ...info, used_bytes: -1 })).toBeUndefined();
    expect(parseStorageLimitErrorInfo({ error: 'x' })).toBeUndefined();
  });

  it('redacts to the code and owner, which every reader still recognises and words', () => {
    const redacted = redactStorageLimitError(new StorageLimitError('x', info));

    expect(redacted.additionalInfo).toStrictEqual({ errorCode: 'storage_limit_exceeded', owner: 'user' });
    expect(isStorageLimitError(redacted)).toBe(true);
    expect(parseStorageLimitErrorInfo({ error: 'x', ...redacted.info })).toStrictEqual(redacted.info);
    expect(redacted.message).toBe(describeStorageLimitError(redacted.info, String));
    expect(describeStorageLimitError({ errorCode: 'org_storage_limit_exceeded', owner: 'org' }, String)).toBe(
      "This change would exceed the organization's storage limit."
    );
  });

  it('parses nothing from a body that has some byte counts but not all', () => {
    expect(parseStorageLimitErrorInfo({ errorCode: 'storage_limit_exceeded', owner: 'user', used_bytes: 5 })).toBe(
      undefined
    );
  });

  it('words each code from its numbers with the supplied byte formatter', () => {
    const formatBytes = (bytes: number) => `${bytes} B`;
    expect(describeStorageLimitError(info, formatBytes)).toBe(
      'Not enough storage: you are using 800000 B of 1000000 B, and this upload needs 300000 B. Free up at least 100000 B to continue.'
    );
    expect(
      describeStorageLimitError(
        { ...info, errorCode: 'org_storage_limit_exceeded', owner: 'org', used_bytes: 0 },
        formatBytes
      )
    ).toBe("This upload (300000 B) is larger than your organization's storage limit of 1000000 B.");
    expect(describeStorageLimitError({ ...info, errorCode: 'file_too_large', used_bytes: 0 }, formatBytes)).toBe(
      'This file (300000 B) is larger than the maximum file size of 1000000 B.'
    );
  });
});

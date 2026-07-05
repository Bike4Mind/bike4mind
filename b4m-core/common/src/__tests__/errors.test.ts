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

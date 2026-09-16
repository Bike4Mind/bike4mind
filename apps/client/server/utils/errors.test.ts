import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { BadRequestError, ForbiddenError } from '@bike4mind/common';
import { ensureAdmin, ensureTavernAccess, parseOrBadRequest } from './errors';

describe('ensureAdmin', () => {
  it('passes for an admin', () => {
    expect(() => ensureAdmin(true)).not.toThrow();
  });

  it('throws ForbiddenError for a non-admin / missing flag', () => {
    expect(() => ensureAdmin(false)).toThrow(ForbiddenError);
    expect(() => ensureAdmin(null)).toThrow(ForbiddenError);
    expect(() => ensureAdmin(undefined)).toThrow(ForbiddenError);
  });
});

describe('ensureTavernAccess', () => {
  it('passes for an admin', () => {
    expect(() => ensureTavernAccess({ isAdmin: true })).not.toThrow();
  });

  it('passes for a non-admin holding the tavern tag', () => {
    expect(() => ensureTavernAccess({ isAdmin: false, tags: ['tavern'] })).not.toThrow();
    expect(() => ensureTavernAccess({ tags: ['Tavern'] })).not.toThrow();
  });

  it('throws ForbiddenError for a non-admin without the tavern tag', () => {
    expect(() => ensureTavernAccess({ isAdmin: false, tags: [] })).toThrow(ForbiddenError);
    expect(() => ensureTavernAccess({ isAdmin: false, tags: ['Analyst'] })).toThrow(ForbiddenError);
  });

  it('throws ForbiddenError for a null/undefined user', () => {
    expect(() => ensureTavernAccess(null)).toThrow(ForbiddenError);
    expect(() => ensureTavernAccess(undefined)).toThrow(ForbiddenError);
  });

  it('throws a 403-status error', () => {
    try {
      ensureTavernAccess(null);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ForbiddenError).statusCode).toBe(403);
    }
  });
});

describe('parseOrBadRequest', () => {
  const schema = z.object({ name: z.string().min(1) });

  it('returns the parsed data on success', () => {
    expect(parseOrBadRequest(schema, { name: 'x' })).toEqual({ name: 'x' });
  });

  it('throws BadRequestError (not a raw ZodError) on failure', () => {
    expect(() => parseOrBadRequest(schema, { name: '' })).toThrow(BadRequestError);
  });

  it('throws a 400-status error', () => {
    try {
      parseOrBadRequest(schema, {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as BadRequestError).statusCode).toBe(400);
    }
  });
});

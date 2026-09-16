/**
 * Re-exported from @bike4mind/common - the canonical location for HTTP error classes.
 * Only `ensureAdmin` is defined locally.
 */
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';
import {
  HttpStatus,
  HTTPError,
  InternalServerError,
  NotFoundError,
  UnprocessableEntityError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  BadGatewayError,
  TooManyRequestsError,
  isZodError,
  canAccessTavern,
} from '@bike4mind/common';

export {
  HttpStatus,
  HTTPError,
  InternalServerError,
  NotFoundError,
  UnprocessableEntityError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  BadGatewayError,
  TooManyRequestsError,
  isZodError,
};

/**
 * Ensure the current user is an admin.
 * Throws ForbiddenError if not.
 *
 * @param isAdmin - The user's isAdmin flag from req.user
 * @throws ForbiddenError if user is not an admin
 */
export function ensureAdmin(isAdmin?: boolean | null): void {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
}

/**
 * Ensure the current user may access the Tavern (admin or 'tavern'-tagged).
 * Throws ForbiddenError if not. Shares the `canAccessTavern` predicate with the
 * client route/tab guard so server and UI authorization can never diverge.
 *
 * @param user - The req.user object (carries isAdmin + tags)
 * @throws ForbiddenError if the user cannot access the Tavern
 */
export function ensureTavernAccess(user?: { isAdmin?: boolean | null; tags?: readonly string[] | null } | null): void {
  if (!canAccessTavern(user)) {
    throw new ForbiddenError('Unauthorized. Tavern access required.');
  }
}

/**
 * Validate `input` against `schema`, throwing a 400 on failure. Every rejection on a route that calls
 * this answers 400, not the 422 a raw ZodError would reach `errorHandler` as (see its `isZodError`
 * branch) - shared so every admin route using it messages off the same status for the same class of
 * mistake instead of each route re-deriving the policy.
 */
export function parseOrBadRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestError(fromZodError(parsed.error).message);
  return parsed.data;
}

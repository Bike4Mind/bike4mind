import { HTTPError } from '@bike4mind/server-utils/utils/errors';
import { SLUG_OWNED_BY_OTHER } from '@bike4mind/common';
import type { BundlePublisher } from '@server/services/publish/publishBundle';

type RouteUser = {
  id: unknown;
  username?: string;
  isAdmin?: boolean;
  organizationId?: unknown;
  createdAt?: Date | string | null;
};

/** The user shape the publish services take, built from the authenticated request user. */
export function toBundlePublisher(user: RouteUser): BundlePublisher & { username?: string; isAdmin?: boolean } {
  return {
    id: String(user.id),
    username: user.username,
    isAdmin: user.isAdmin,
    organizationId: user.organizationId ? String(user.organizationId) : null,
    createdAt: user.createdAt,
  };
}

/**
 * Re-statuses a service error to one the route's contract declares. 403 is reserved for API key scope,
 * so a service 403/401 reads as "not found" where the contract has a 404 (no probing other people's
 * pages) and as 422 otherwise; the legacy 400/413 validation statuses are 422. A slug owned by another
 * user is 409. Anything else passes through untouched.
 */
export function toDeclaredStatus(err: unknown, declared: readonly number[]): unknown {
  if (!(err instanceof HTTPError)) return err;
  const info = err.additionalInfo ?? {};
  const keep = (status: number, message = err.message) => new HTTPError(status, message, info);
  if (info.errorCode === SLUG_OWNED_BY_OTHER) return keep(409);
  const status = err.statusCode;
  if (status === 401 || status === 403 || status === 404) {
    if (declared.includes(404)) return keep(404, status === 404 ? err.message : 'Published page not found');
    return keep(422);
  }
  if (status === 400 || status === 413) return keep(422);
  return err;
}

/** Runs a service call, rethrowing its HTTP errors with a status the contract declares. */
export async function withDeclaredStatuses<T>(declared: readonly number[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toDeclaredStatus(err, declared);
  }
}

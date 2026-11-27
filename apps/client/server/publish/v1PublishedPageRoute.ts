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
 * The remap for a route whose contract declares `declared`. 403 is reserved for API key scope, so a
 * service 403/401/404 reads as "not found" where the contract has a 404 and as 422 otherwise; the
 * legacy 400/413 validation statuses are 422. A slug owned by another user is 409. Anything else is
 * left alone.
 */
export function declaredStatuses(declared: readonly number[]): (error: HTTPError) => number | undefined {
  return error => {
    if (error.additionalInfo?.errorCode === SLUG_OWNED_BY_OTHER) return 409;
    const status = error.statusCode;
    if (status === 401 || status === 403 || status === 404) return declared.includes(404) ? 404 : 422;
    if (status === 400 || status === 413) return 422;
    return undefined;
  };
}

/**
 * Runs a service call and re-throws its HTTPError at the status `remap` picks, keeping message and
 * additionalInfo, so a route answers only with statuses its contract declares. `remap` returns
 * undefined to leave an error alone.
 */
export async function withStatusMap<T>(
  fn: () => Promise<T>,
  remap: (error: HTTPError) => number | undefined
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HTTPError) {
      const status = remap(error);
      if (status !== undefined && status !== error.statusCode) {
        throw new HTTPError(status, error.message, error.additionalInfo);
      }
    }
    throw error;
  }
}

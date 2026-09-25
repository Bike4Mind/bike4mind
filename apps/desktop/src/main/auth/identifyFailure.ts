import { SessionRevokedError } from '@bike4mind/client-auth';
import type { AuthError } from '@shared/auth';

/**
 * How an `/api/identify` failure should be handled. Two of these are NOT authentication
 * failures and must not be rendered as "login failed", because doing so strands the user
 * with no way forward (see apps/client/server/auth/auth.ts):
 *
 * - `policy-acceptance-required`: 403 + `policyAcceptanceRequired`, raised when the account has
 *   no `aupAcceptedVersion`. The request IS authenticated; only acceptance is missing.
 * - `mfa-required`: 401 + `mfaPending`, raised for a first-factor-only session.
 *
 * Both are resolved in the browser, so the UI offers that link rather than a retry of a
 * sign-in that would land in exactly the same place.
 *
 * `transient` means the credentials are fine and the backend is not reachable - the caller
 * keeps the stored session rather than throwing it away over a dropped connection.
 */
export type IdentifyOutcome = 'policy-acceptance-required' | 'mfa-required' | 'signed-out' | 'transient';

export interface IdentifyFailure {
  outcome: IdentifyOutcome;
  error: AuthError;
}

/**
 * Shape of an axios rejection, duck-typed rather than imported. This module has no other
 * reason to depend on axios, and the whole contract is `response.status` + `response.data`.
 */
interface HttpErrorLike {
  response?: { status?: number; data?: unknown };
  message?: string;
}

function asHttpError(error: unknown): HttpErrorLike | null {
  if (typeof error !== 'object' || error === null) return null;
  return error as HttpErrorLike;
}

function responseFields(error: HttpErrorLike | null): Record<string, unknown> {
  const data = error?.response?.data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

function describe(fields: Record<string, unknown>, fallback: string): string {
  const description = fields.error_description ?? fields.message ?? fields.error;
  return typeof description === 'string' && description.trim() ? description : fallback;
}

export function classifyIdentifyFailure(error: unknown): IdentifyFailure {
  const http = asHttpError(error);
  const status = http?.response?.status;
  const fields = responseFields(http);

  if (status === 403 && fields.policyAcceptanceRequired === true) {
    return {
      outcome: 'policy-acceptance-required',
      error: {
        message: describe(fields, 'Accept the Terms of Service and Acceptable Use Policy to continue.'),
        remedy: 'accept-policy',
      },
    };
  }

  if (status === 401 && fields.mfaPending === true) {
    return {
      outcome: 'mfa-required',
      error: {
        message: describe(fields, 'Two-factor verification is required before this account can be used.'),
        remedy: 'complete-mfa',
      },
    };
  }

  // Definitively revoked: the refresh token was rejected, or a 401 survived a refresh.
  if (error instanceof SessionRevokedError) {
    return { outcome: 'signed-out', error: { message: error.message, remedy: 'retry-sign-in' } };
  }

  if (status === 401) {
    return {
      outcome: 'signed-out',
      error: { message: 'This session is no longer valid. Sign in again.', remedy: 'retry-sign-in' },
    };
  }

  const detail = typeof http?.message === 'string' && http.message ? `: ${http.message}` : '.';
  return {
    outcome: 'transient',
    error: { message: `Could not reach the server${detail}`, remedy: 'retry' },
  };
}

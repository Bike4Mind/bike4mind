import { ApiKeyStatus, type AdminApiKeyAccess, type AdminApiKeyRequestCounts } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

export const KEY_STATUS: Readonly<Record<ApiKeyStatus, { label: string; tone: AdminStatusTone }>> = {
  [ApiKeyStatus.ACTIVE]: { label: 'Active', tone: 'good' },
  [ApiKeyStatus.DISABLED]: { label: 'Revoked', tone: 'neutral' },
  [ApiKeyStatus.EXPIRED]: { label: 'Expired', tone: 'neutral' },
  [ApiKeyStatus.RATE_LIMITED]: { label: 'Rate limited', tone: 'warn' },
};

// Immediate revoke and its Undo carry fixed reasons: the action model takes no reason for a
// reversible write, but the server audits every key write with one.
export const SINGLE_REVOKE_REASON = 'Revoked from the user profile';
export const UNDO_REVOKE_REASON = 'Undid a revoke from the user profile';

const NO_REQUESTS: AdminApiKeyRequestCounts = { last24h: 0, last7d: 0 };

export const requestCounts = (
  requests: Readonly<Record<string, AdminApiKeyRequestCounts>> | undefined,
  keyId: string
): AdminApiKeyRequestCounts => requests?.[keyId] ?? NO_REQUESTS;

/** The busiest key's 7-day count, which every row's inline bar is scaled against. */
export const maxWeeklyRequests = (requests: Readonly<Record<string, AdminApiKeyRequestCounts>> | undefined): number =>
  Math.max(0, ...Object.values(requests ?? {}).map(counts => counts.last7d));

const ADMIN_KEYS_STILL_WORK = 'Keys an admin generated for them still work.';

/** The subscription gate in plain words: whether personal keys work for this user, and why. */
export function describeKeyAccess(access: AdminApiKeyAccess): { tone: AdminStatusTone; label: string; text: string } {
  switch (access.basis) {
    case 'admin':
      return { tone: 'good', label: 'Allowed', text: 'Admins can always mint and use personal API keys.' };
    case 'developer':
      return {
        tone: 'good',
        label: 'Allowed',
        text: 'Developer accounts can mint and use personal API keys without a paid subscription.',
      };
    case 'open_to_all':
      return { tone: 'good', label: 'Allowed', text: 'API keys are open to every user right now, paid or not.' };
    case 'paid_subscription':
      return {
        tone: 'good',
        label: 'Allowed',
        text: 'This user has an active paid subscription, so their personal API keys work.',
      };
    case 'credit_purchase':
      return {
        tone: 'good',
        label: 'Allowed',
        text: 'This user has bought credits, so their personal API keys work without a subscription.',
      };
    case 'no_paid_subscription':
      return {
        tone: 'warn',
        label: 'Blocked',
        text: `API keys need an active paid subscription or a credit purchase and this user has neither, so their personal keys are refused. ${ADMIN_KEYS_STILL_WORK}`,
      };
    case 'disabled':
      return {
        tone: 'warn',
        label: 'Blocked',
        text: `API keys are turned off for everyone except admins and developers. ${ADMIN_KEYS_STILL_WORK}`,
      };
  }
}

/** The server's error text when it sent one, so a 409 says why instead of "Request failed". */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const data: unknown = (error as { response?: { data?: unknown } }).response?.data;
    if (typeof data === 'object' && data !== null) {
      for (const field of ['error', 'message'] as const) {
        const value: unknown = (data as Record<string, unknown>)[field];
        if (typeof value === 'string' && value.trim()) return value;
      }
    }
  }
  return fallback;
}

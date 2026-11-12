import { ApiKeyStatus } from '@bike4mind/common';

export const formatDate = (value?: Date | string): string => (value ? new Date(value).toLocaleDateString() : '\u2014');

export const STATUS_LABEL: Readonly<Record<ApiKeyStatus, { label: string; color: 'success' | 'neutral' | 'warning' }>> =
  {
    [ApiKeyStatus.ACTIVE]: { label: 'Active', color: 'success' },
    [ApiKeyStatus.DISABLED]: { label: 'Revoked', color: 'neutral' },
    [ApiKeyStatus.EXPIRED]: { label: 'Expired', color: 'neutral' },
    [ApiKeyStatus.RATE_LIMITED]: { label: 'Rate limited', color: 'warning' },
  };

// Expiry is checked at request time and never written back to status, so derive it here.
export const effectiveStatus = (key: { status: ApiKeyStatus; expiresAt?: Date | string }): ApiKeyStatus =>
  key.status === ApiKeyStatus.ACTIVE && key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()
    ? ApiKeyStatus.EXPIRED
    : key.status;

export const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

export interface DlqExpiry {
  ageMs: number;
  /** Null when the queue retention is unknown. */
  remainingMs: number | null;
  warn: boolean;
}

export const getDlqExpiry = (
  sentTimestamp: string | undefined,
  retentionSeconds: number | undefined,
  now: number = Date.now()
): DlqExpiry | null => {
  const sentAt = parseInt(sentTimestamp ?? '', 10);
  if (!Number.isFinite(sentAt)) return null;
  const ageMs = Math.max(now - sentAt, 0);
  if (retentionSeconds === undefined || retentionSeconds <= 0) return { ageMs, remainingMs: null, warn: false };
  const remainingMs = Math.max(sentAt + retentionSeconds * 1000 - now, 0);
  return { ageMs, remainingMs, warn: remainingMs < EXPIRY_WARNING_MS };
};

export const formatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};

export const formatExpiresIn = (expiry: DlqExpiry): string => {
  if (expiry.remainingMs === null) return 'N/A';
  return expiry.remainingMs === 0 ? 'Expired' : formatDuration(expiry.remainingMs);
};

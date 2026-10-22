const STORAGE_KEY_PREFIX = 'credit-nudge-dismissed-at';
export const CREDIT_NUDGE_SNOOZE_MS = 24 * 60 * 60 * 1000;

// Scoped per user so one person's dismissal on a shared browser does not hide the nudge from the
// next. With no user loaded there is nothing to scope to: report not dismissed and store nothing.
const storageKey = (userId: string | null | undefined): string | null =>
  userId ? `${STORAGE_KEY_PREFIX}:${userId}` : null;

/** True while this user's low-credit nudge dismissal made on this browser is less than 24h old. */
export function isCreditNudgeDismissed(userId: string | null | undefined, now: number = Date.now()): boolean {
  const key = storageKey(userId);
  if (!key) return false;
  try {
    const raw = window.localStorage.getItem(key);
    const dismissedAt = raw === null ? NaN : Number(raw);
    // A timestamp in the future (clock change) is treated as expired rather than snoozing forever.
    return Number.isFinite(dismissedAt) && dismissedAt <= now && now - dismissedAt < CREDIT_NUDGE_SNOOZE_MS;
  } catch {
    return false;
  }
}

/** Records a dismissal so the low-credit nudge stays quiet for this user for the next 24h on this browser. */
export function dismissCreditNudge(userId: string | null | undefined, now: number = Date.now()): void {
  const key = storageKey(userId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, String(now));
  } catch {
    // Storage blocked: the in-memory dismissal still applies for this page load.
  }
}

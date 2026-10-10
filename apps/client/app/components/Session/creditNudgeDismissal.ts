const STORAGE_KEY = 'credit-nudge-dismissed-at';
export const CREDIT_NUDGE_SNOOZE_MS = 24 * 60 * 60 * 1000;

/** True while a low-credit nudge dismissal made on this browser is less than 24h old. */
export function isCreditNudgeDismissed(now: number = Date.now()): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const dismissedAt = raw === null ? NaN : Number(raw);
    // A timestamp in the future (clock change) is treated as expired rather than snoozing forever.
    return Number.isFinite(dismissedAt) && dismissedAt <= now && now - dismissedAt < CREDIT_NUDGE_SNOOZE_MS;
  } catch {
    return false;
  }
}

/** Records a dismissal so the low-credit nudge stays quiet for the next 24h on this browser. */
export function dismissCreditNudge(now: number = Date.now()): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(now));
  } catch {
    // Storage blocked: the in-memory dismissal still applies for this page load.
  }
}

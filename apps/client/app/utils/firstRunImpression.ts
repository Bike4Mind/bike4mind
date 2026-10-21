const impressionKey = (event: string, userId: string) => `firstRunImpression:${event}:${userId}`;

/**
 * Claims the one-per-user (per browser) log of a first-run impression event, so a remount or a
 * revisit does not re-log it. True when the caller should log. Without a userId or storage it
 * falls back to true, leaving the caller's per-mount ref as the only guard.
 */
export function claimFirstRunImpression(event: string, userId: string | undefined): boolean {
  if (!userId) return true;
  try {
    const key = impressionKey(event, userId);
    if (localStorage.getItem(key) === '1') return false;
    localStorage.setItem(key, '1');
  } catch {
    // Private mode / full storage: count per mount instead.
  }
  return true;
}

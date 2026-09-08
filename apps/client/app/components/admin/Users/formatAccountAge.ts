/**
 * Relative account age for the admin users table, e.g. "3d ago".
 *
 * Relative rather than absolute because of what the column is FOR: the table
 * already sorts by createdAt, and the question being asked while scanning it is
 * "how new is this account", which a raw date makes the reader compute. The exact
 * timestamp is still one hover away (see the title attribute at the call site),
 * so precision is available without spending column width on it.
 *
 * Returns null for a missing or unparseable value rather than a placeholder date -
 * every user has timestamps (UserModel sets `timestamps: true`), so an absent
 * value means a projection dropped the field, and rendering "Jan 1 1970" would
 * look like data instead of like nothing.
 */
export function formatAccountAge(createdAt: string | Date | undefined | null, now: Date = new Date()): string | null {
  if (!createdAt) return null;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const ms = created.getTime();
  if (!Number.isFinite(ms)) return null;

  const seconds = Math.floor((now.getTime() - ms) / 1000);
  // Clock skew or a future-dated record: say "today" rather than "-3d ago".
  if (seconds < 0) return 'today';
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Full timestamp for the hover title; null when there is nothing to show. */
export function formatAccountCreatedTitle(createdAt: string | Date | undefined | null): string | null {
  if (!createdAt) return null;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (!Number.isFinite(created.getTime())) return null;
  return `Account created ${created.toLocaleString()}`;
}

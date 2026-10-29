import type { AuditChange, AuditEntry } from '@bike4mind/common';
import { undoAdminReason } from '../../../shared/adminReason';
import type { AdminUserProfile } from '../userProfileModel';

/**
 * Plain-language wording for admin audit entries about one user, for the Activity and Admin log tabs.
 * Stored summaries are terse ("updated isBanned"), so the profile words the common actions itself.
 */

const ACTION_SENTENCES: Readonly<Record<string, string>> = {
  'user.mfa.reset': 'Reset two-factor authentication',
  'user.impersonation.started': 'Started signing in as this user',
  'user.impersonation.ended': 'Stopped signing in as this user',
  'user.sessions.revoked': 'Signed this user out everywhere',
  'user.session.revoked': 'Signed out one session',
  'user.email.verified': 'Marked email verified',
  'user.email.unverified': 'Marked email unverified',
  'user.email.verification_resent': 'Resent the verification email',
  'user.subscription.granted': 'Granted a subscription',
  'user.subscription.removed': 'Removed the subscription',
  'user.api_key.generated': 'Generated an API key',
  'user.api_key.rate_limit_updated': 'Changed API key rate limits',
  'user.api_key.rate_limit_reset': 'Reset API key rate limits',
  'user.api_key_trust.approved': 'Approved API key trust',
  'user.api_key_trust.revoked': 'Revoked API key trust',
  'user.role.admin_granted': 'Granted the Super Admin role',
  'user.role.admin_revoked': 'Revoked the Super Admin role',
  'user.storage.recalculated': 'Recalculated storage',
  'user.created': 'Created the account',
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  isBanned: 'Suspended',
  isModerated: 'Restricted',
  tags: 'Tags',
  emailVerified: 'Email verified',
  currentCredits: 'Credits',
  isAdmin: 'Super Admin',
  moderationStatus: 'Moderation status',
  name: 'Name',
  email: 'Email',
  username: 'Username',
  level: 'Level',
};

const humanizeField = (field: string): string => {
  const words = field
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.]/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? humanizeField(field);

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const formatNumber = (value: number) => value.toLocaleString('en-US');

/** A stored before/after value as text; an empty value reads as a dash, never as blank. */
export const formatAuditValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 0 ? 'None' : value.map(formatAuditValue).join(', ');
  return JSON.stringify(value);
};

const tagSentence = (before: unknown, after: unknown): string => {
  const previous = asStrings(before);
  const next = asStrings(after);
  const added = next.filter(tag => !previous.includes(tag));
  const removed = previous.filter(tag => !next.includes(tag));
  const parts = [
    added.length > 0 && `added ${added.join(', ')}`,
    removed.length > 0 && `removed ${removed.join(', ')}`,
  ].filter(Boolean);
  return parts.length > 0 ? `Tags: ${parts.join('; ')}` : 'Changed tags';
};

const changeSentence = ({ field, before, after }: AuditChange): string => {
  switch (field) {
    case 'isBanned':
      return after ? 'Suspended account' : 'Reinstated account';
    case 'isModerated':
      return after ? 'Restricted account' : 'Lifted restriction';
    case 'emailVerified':
      return after ? 'Marked email verified' : 'Marked email unverified';
    case 'tags':
      return tagSentence(before, after);
    case 'currentCredits': {
      if (typeof before !== 'number' || typeof after !== 'number') return 'Adjusted credits';
      const delta = after - before;
      const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
      return `Credits ${sign}${formatNumber(Math.abs(delta))} (${formatNumber(before)} to ${formatNumber(after)})`;
    }
    default:
      return `Changed ${fieldLabel(field).toLowerCase()}`;
  }
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One line naming what the admin did, e.g. "Suspended account" or "Credits +2,000 (5,410 to 7,410)". */
export const describeAuditEntry = (entry: AuditEntry): string => {
  if (entry.action.endsWith('.denied')) return `Blocked: ${entry.summary}`;
  const known = ACTION_SENTENCES[entry.action];
  if (known) return known;
  if (entry.changes && entry.changes.length > 0) return entry.changes.map(changeSentence).join('; ');
  return capitalize(entry.summary);
};

// Undo replays `before` through the same audited update the profile's dialogs use. Only fields whose
// previous value can be written back as-is qualify; credits, roles and deletions have their own flows.
const UNDOABLE_FIELDS: ReadonlySet<string> = new Set(['isBanned', 'isModerated', 'tags']);
// The update route requires `statusChangeReason` whenever one of these flips, undo included.
const STATUS_FIELDS: ReadonlySet<string> = new Set(['isBanned', 'isModerated']);
// Older suspensions and restrictions were recorded as user.profile.updated, so both shapes undo.
const UNDOABLE_ACTIONS: ReadonlySet<string> = new Set([
  'user.profile.updated',
  'user.suspended',
  'user.reinstated',
  'user.restricted',
  'user.restriction_lifted',
]);

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const currentValue = (user: AdminUserProfile, field: string): unknown => {
  switch (field) {
    case 'isBanned':
      return Boolean(user.isBanned);
    case 'isModerated':
      return Boolean(user.isModerated);
    case 'tags':
      return user.tags ?? [];
    default:
      return undefined;
  }
};

export type AuditUndo = { patch: Record<string, unknown>; redo: Record<string, unknown> };

/**
 * The update that reverses `entry`, or null when that is no longer safe: the action is not a plain
 * field change, a later loaded entry changed the same field, or the account no longer holds the value
 * this entry wrote. `newerEntries` are the entries listed above it (newest first).
 */
export const auditUndo = (
  entry: AuditEntry,
  newerEntries: readonly AuditEntry[],
  user: AdminUserProfile
): AuditUndo | null => {
  const changes = entry.changes ?? [];
  if (!UNDOABLE_ACTIONS.has(entry.action) || changes.length === 0) return null;
  if (!changes.every(change => UNDOABLE_FIELDS.has(change.field))) return null;
  const touched = new Set(changes.map(change => change.field));
  const supersededBy = newerEntries.some(newer => newer.changes?.some(change => touched.has(change.field)));
  if (supersededBy) return null;
  if (!changes.every(change => sameValue(currentValue(user, change.field), change.after))) return null;
  // An entry from before reasons were stored has none; its own sentence stands in.
  const reason = entry.reason || describeAuditEntry(entry);
  const touchesStatus = changes.some(change => STATUS_FIELDS.has(change.field));
  return {
    patch: {
      ...Object.fromEntries(changes.map(change => [change.field, change.before ?? defaultFor(change.field)])),
      ...(touchesStatus && { statusChangeReason: undoAdminReason(reason) }),
    },
    redo: {
      ...Object.fromEntries(changes.map(change => [change.field, change.after])),
      ...(touchesStatus && { statusChangeReason: reason }),
    },
  };
};

const defaultFor = (field: string): unknown => (field === 'tags' ? [] : false);

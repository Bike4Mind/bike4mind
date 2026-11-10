import type { AdminPermissionRequirement } from '@bike4mind/common';

/**
 * The admin queues the sidebar counts: one key per page whose items wait for an admin to act.
 * `GET /api/admin/action-counts` (server/admin/actionCounts.ts) answers every key in one request;
 * adminSidebarConfig.tsx names the key each sidebar item shows.
 */
export const ADMIN_ACTION_COUNT_KEYS = [
  'waitingSubscribers',
  'unreviewedAudit',
  'moderationReview',
  'heldSignupGrants',
  'signupDomainHolds',
  'signupRiskReview',
  'approvals',
  'publishedPages',
  'stripeDisputes',
  'modelLifecycle',
  'secretRotation',
  'sreAgent',
  'feedback',
  'deadLetters',
] as const;

export type AdminActionCountKey = (typeof ADMIN_ACTION_COUNT_KEYS)[number];

/**
 * A key is absent when the viewer may not act on that queue, and null when its count failed.
 * Counts stop at ADMIN_ACTION_COUNT_CAP, so a value equal to the cap means "at least that many".
 */
export type AdminActionCounts = Partial<Record<AdminActionCountKey, number | null>>;

export const ADMIN_ACTION_COUNT_CAP = 100;

/** What a badge counts, read after the number ("3 audit entries to review"). */
export const ADMIN_ACTION_COUNT_LABELS: Record<AdminActionCountKey, string> = {
  waitingSubscribers: 'waiting for an invite',
  unreviewedAudit: 'audit entries to review',
  moderationReview: 'incidents to review',
  heldSignupGrants: 'held signup grants',
  signupDomainHolds: 'domain holds to review',
  signupRiskReview: 'signups to review',
  approvals: 'approvals to decide',
  publishedPages: 'reported pages',
  stripeDisputes: 'disputes to resolve',
  modelLifecycle: 'model suggestions to review',
  secretRotation: 'secrets overdue for rotation',
  sreAgent: 'failed SRE fixes',
  feedback: 'new feedback items',
  deadLetters: 'dead-letter messages',
};

/** "99+" once a count reaches the cap, so a huge backlog never widens the sidebar. */
export const formatAdminActionCount = (count: number): string =>
  count >= ADMIN_ACTION_COUNT_CAP ? `${ADMIN_ACTION_COUNT_CAP - 1}+` : String(count);

/** Who may see a count: a full admin, or a delegate meeting the queue read requirement. */
export type AdminActionCountAccess = 'fullAdmin' | AdminPermissionRequirement;

/**
 * Audit-log event enums.
 *
 * Kept in a dedicated, dependency-free module so that `analytics/index.ts`
 * can spread them into `ANALYTICS_EVENTS` without creating an import cycle
 * with `auditLog.ts` (which imports `logEvent` from `analyticsLog.ts`, which
 * in turn imports from `analytics/index.ts`).
 */

export enum EmailAuditEvents {
  // Email Verification Events
  EMAIL_VERIFICATION_SENT = 'EMAIL_VERIFICATION_SENT',
  EMAIL_VERIFICATION_RESENT = 'EMAIL_VERIFICATION_RESENT',
  EMAIL_VERIFICATION_SUCCESS = 'EMAIL_VERIFICATION_SUCCESS',
  EMAIL_VERIFICATION_FAILED = 'EMAIL_VERIFICATION_FAILED',
  EMAIL_VERIFICATION_TOKEN_EXPIRED = 'EMAIL_VERIFICATION_TOKEN_EXPIRED',
  EMAIL_VERIFICATION_TOKEN_REUSED = 'EMAIL_VERIFICATION_TOKEN_REUSED',

  // Email Change Events
  EMAIL_CHANGE_REQUESTED = 'EMAIL_CHANGE_REQUESTED',
  EMAIL_CHANGE_SUCCESS = 'EMAIL_CHANGE_SUCCESS',
  EMAIL_CHANGE_FAILED = 'EMAIL_CHANGE_FAILED',
  EMAIL_CHANGE_CANCELLED = 'EMAIL_CHANGE_CANCELLED',
  EMAIL_CHANGE_TOKEN_EXPIRED = 'EMAIL_CHANGE_TOKEN_EXPIRED',
  EMAIL_CHANGE_TOKEN_REUSED = 'EMAIL_CHANGE_TOKEN_REUSED',

  // Admin Actions
  ADMIN_EMAIL_VERIFIED = 'ADMIN_EMAIL_VERIFIED',
  ADMIN_EMAIL_UNVERIFIED = 'ADMIN_EMAIL_UNVERIFIED',
  ADMIN_VERIFICATION_RESENT = 'ADMIN_VERIFICATION_RESENT',
  ADMIN_EMAIL_CHANGE_RESENT = 'ADMIN_EMAIL_CHANGE_RESENT',
}

export enum AdminConfigAuditEvents {
  // What's New Configuration Events
  WHATS_NEW_CONFIG_UPDATED = 'WHATS_NEW_CONFIG_UPDATED',
  WHATS_NEW_CONFIG_VIEWED = 'WHATS_NEW_CONFIG_VIEWED',
  WHATS_NEW_SYNC_TRIGGERED = 'WHATS_NEW_SYNC_TRIGGERED',

  // System Health Events
  ADMIN_TEST_EMAIL_SENT = 'ADMIN_TEST_EMAIL_SENT',
  ADMIN_DATABASE_TEST = 'ADMIN_DATABASE_TEST',
  ADMIN_OAUTH_TEST = 'ADMIN_OAUTH_TEST',

  // Security Scan Schedule Events
  SECURITY_SCAN_SCHEDULE_ENABLED = 'SECURITY_SCAN_SCHEDULE_ENABLED',
  SECURITY_SCAN_SCHEDULE_DISABLED = 'SECURITY_SCAN_SCHEDULE_DISABLED',
  SECURITY_SCAN_SCHEDULE_UPDATED = 'SECURITY_SCAN_SCHEDULE_UPDATED',
  SECURITY_SCAN_SCHEDULE_TRIGGERED = 'SECURITY_SCAN_SCHEDULE_TRIGGERED',
  SECURITY_SCAN_SCHEDULE_FAILED = 'SECURITY_SCAN_SCHEDULE_FAILED',
  SECURITY_SCAN_SCHEDULE_SKIPPED = 'SECURITY_SCAN_SCHEDULE_SKIPPED',
}

export enum AdminOrgAuditEvents {
  ORG_GRANTED = 'ORG_GRANTED',
  ORG_TOPPED_UP = 'ORG_TOPPED_UP',
  ORG_SEATS_CHANGED = 'ORG_SEATS_CHANGED',
  // Domain-signup provisioning raised the seat ceiling to admit a partner-rule user instead of
  // rejecting at capacity (#1239). System action (no admin actor); the audited userId is the
  // admitted user, with the org, before/after ceiling, and trigger route in metadata - a raise
  // nobody can see is indistinguishable from having no ceiling at all.
  ORG_SEAT_CEILING_RAISED = 'ORG_SEAT_CEILING_RAISED',
  ORG_CONVERT_INITIATED = 'ORG_CONVERT_INITIATED',
  ORG_REVOKED = 'ORG_REVOKED',
  // Group-type grant/revoke (org-groups #1172). One event carries the diff (added/removed types
  // + soft-deleted group ids) so "who granted access to a type that can reach confidential data"
  // is answerable from the audit trail.
  ORG_GROUP_TYPES_UPDATED = 'ORG_GROUP_TYPES_UPDATED',
  // The rest of the org-groups privileged mutations (org-groups #1172). Same rationale: "who put
  // user X in the confidential group" and "who appointed the admin who did it" must be answerable.
  ORG_ADMINS_UPDATED = 'ORG_ADMINS_UPDATED',
  ORG_GROUP_MEMBER_ASSIGNED = 'ORG_GROUP_MEMBER_ASSIGNED',
  ORG_GROUP_MEMBER_UNASSIGNED = 'ORG_GROUP_MEMBER_UNASSIGNED',
  // A group invite is a deferred ORG_GROUP_MEMBER_ASSIGNED: whoever mints it decides who may join
  // the group, but the membership write lands later in sharingService/accept.ts under the
  // recipient's id. Without this event the grant side of that pair has no actor recorded.
  ORG_GROUP_INVITE_CREATED = 'ORG_GROUP_INVITE_CREATED',
}

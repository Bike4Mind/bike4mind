import type { ModerationLabelHit } from '../../schemas/imageModerationIncident';

/** One moderation-incident row surfaced to the compliance modal (metadata only). */
export interface ComplianceModerationIncident {
  labels: ModerationLabelHit[];
  provider: string;
  model: string;
  /** ISO 8601 string - this is a JSON wire payload, not a Mongoose document. */
  createdAt: string;
}

/**
 * One recent auth-trail row for the compliance modal - event/actorIp/userAgent/createdAt only.
 * Deliberately a narrow subset of IUserAuthAuditLogDocument: strategy, requestId, metadata, and
 * userId are intentionally excluded (not needed for the read-only investigation view). actorUserId
 * IS included: for an admin-driven event (e.g. session_revoked) it's exactly the forensic detail
 * an investigation view needs - who did this to the user, not just that it happened.
 */
export interface ComplianceAuthEvent {
  event: string;
  actorIp: string;
  userAgent: string;
  /** The user who performed the action, when it differs from the subject (e.g. an admin force-logout). */
  actorUserId?: string;
  /** ISO 8601 string. */
  createdAt: string;
}

/** Payload of GET /api/admin/users/:userId/compliance. Read-only. */
export interface UserComplianceResponse {
  /** The AUP/ToS version the user accepted (`CURRENT_POLICY_VERSION`, `'grandfathered'`, or null). */
  aupAcceptedVersion: string | null;
  /** ISO 8601 string, or null if never accepted. */
  aupAcceptedAt: string | null;
  /** Whether the user attested to being an adult (age gate). */
  ageAttestedAdult: boolean | null;
  /** The in-force policy version (`CURRENT_POLICY_VERSION`) to compare against. */
  currentPolicyVersion: string;
  /** True when `aupAcceptedVersion` matches the in-force `currentPolicyVersion`. */
  isCurrent: boolean;
  moderationIncidents: ComplianceModerationIncident[];
  flags: { isBanned: boolean; isModerated: boolean; disputePending: boolean };
  recentAuthEvents: ComplianceAuthEvent[];
}

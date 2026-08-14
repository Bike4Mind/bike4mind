import type { DataLakeAccessRole, DataLakePrincipalType } from './DataLakeAccessGrantTypes';
import type { LakeAccessPrincipalKind, LakeAccessSurface } from './LakeAccessEventTypes';

// ── Owner-facing access & membership view (#1672) ────────────────────────────
//
// The read-only compliance surface a lake owner needs to answer the two questions asked first:
//   - "Who can see this?"  -> `grants` (persisted rows) + `channels` (the gate-based read paths).
//   - "Who actually has?"  -> `history`, aggregated from the access-audit trail (#1663).
//
// This module is the assembled VIEW shape only; it reads the access-grant relation (#1667), the
// gate config on the lake, and the access-audit events (#1663), and combines them. It never writes.
//
// EFFECTIVE, not just stored: a grant's `status` is resolved against `generatedAt`, so a lapsed
// grant renders as `expired` and can never be mistaken for live access - the specific failure mode
// the read-time-resolution decision in #1673 exists to avoid. Tag/entitlement access is not
// materialized into rows (it stays live), so it is surfaced as a `channel`, not a fake grant row.

/** Whether a grant is live right now. Resolved at read time against the view's `generatedAt`. */
export type LakeGrantStatus = 'active' | 'expired';

/** One persisted access-grant row, enriched with resolved display names and its live status. */
export interface LakeAccessGrantView {
  principalType: DataLakePrincipalType;
  principalId: string;
  /** Resolved display name (a user's name/email, or an org's name); absent if the principal no
   * longer resolves - a deleted user still appears as a row so the audit trail stays complete. */
  principalName?: string;
  role: DataLakeAccessRole;
  grantedByUserId: string;
  grantedByName?: string;
  /** The grant time - the grant row's `createdAt` (there is no separate field; see the relation). */
  grantedAt: Date;
  /** Absent/null = never expires. */
  expiresAt?: Date | null;
  status: LakeGrantStatus;
}

/**
 * A gate-based read path into the lake, distinct from an explicit grant row. Tag/entitlement/org/
 * public are resolved LIVE on every request (never stored as rows), so they are surfaced here as
 * channels the owner can see, not as membership rows that could go stale.
 */
export type LakeAccessChannelKind = 'tag' | 'entitlement' | 'organization' | 'public';

export interface LakeAccessChannel {
  kind: LakeAccessChannelKind;
  /** The gate value: the required tag, the entitlement key, or the org id. Absent for `public`. */
  value?: string;
  /** Human label where one resolves (e.g. the organization's name). */
  label?: string;
  /**
   * Effective holder count, populated ONLY where a bounded query exists (organization membership).
   * Deliberately absent for tag/entitlement channels: enumerating or counting their holders means
   * scanning the whole user table - the exact full-install scan #1667 set out to remove - so the
   * channel is surfaced honestly WITHOUT a count rather than paid for. Absent means "not counted",
   * never "zero".
   */
  holderCount?: number;
}

/** Per-principal read aggregation from the access-audit trail: how often, when, and through what. */
export interface LakeAccessHistoryEntry {
  principalKind: LakeAccessPrincipalKind;
  principalId: string;
  principalName?: string;
  /** Set when a system/agent principal read on a human's behalf, so the human stays findable. */
  onBehalfOfUserId?: string;
  onBehalfOfName?: string;
  readCount: number;
  lastAccessedAt: Date;
  firstAccessedAt: Date;
  /** The distinct surfaces this principal read through (semantic search, chat KB, forced, ...). */
  surfaces: LakeAccessSurface[];
}

/**
 * The assembled owner-facing access view. Combines persisted grants, the gate-based access
 * channels, and the read history into one exportable compliance artifact.
 *
 * NO `pendingRequests` field: no access-request flow exists yet (issue #1672 item 3 is explicitly
 * conditional on it landing). Per this epic's rule against a stored/returned field nothing produces,
 * it is omitted rather than shipped as an always-empty array; it joins the shape when the flow lands.
 */
export interface LakeAccessView {
  lakeId: string;
  lakeName: string;
  /** Persisted grant rows (owner/curator/reader), INCLUDING lapsed rows tagged `expired`. */
  grants: LakeAccessGrantView[];
  /** The gate-based effective-access channels - the read paths that are not explicit grants. */
  channels: LakeAccessChannel[];
  /** Per-principal read aggregation from the access-audit events. */
  history: LakeAccessHistoryEntry[];
  /** True when the audit read hit its cap: `history` is then the most-recent window, not the whole
   * trail. Surfaced so an owner is never misled into reading a capped view as complete. */
  historyTruncated: boolean;
  /** When the view was assembled - the instant grant expiry (`status`) was resolved against. */
  generatedAt: Date;
}

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

/** Display label per channel kind, keyed by the enum so a new kind fails the build here. */
const CHANNEL_KIND_LABEL: Record<LakeAccessChannelKind, string> = {
  tag: 'Tag',
  entitlement: 'Entitlement',
  organization: 'Organization',
  public: 'Public',
};

function describeChannelDetail(channel: LakeAccessChannel): string | undefined {
  if (channel.kind === 'public') return 'everyone across the app';
  if (channel.kind !== 'organization') return channel.value;
  const name = channel.label ?? channel.value;
  if (channel.holderCount == null) return name;
  // "members with access", not "members": the count is the set the read gate would ADMIT, which is
  // deliberately smaller than the organization's own member total (pending and share-only members
  // are excluded). An unqualified "members" invites a reader to read that gap as a defect.
  const noun = channel.holderCount === 1 ? 'member' : 'members';
  return `${name} (${channel.holderCount} ${noun} with access)`;
}

/**
 * The exact human text for one channel, SHARED by the access modal and the CSV export so a
 * compliance reader comparing the exported file against the screen never sees the two disagree.
 * The CSV keeps `kind`/`value`/`label`/`holderCount` as separate machine-readable columns; this is
 * the rendered form that sits beside them.
 */
export function describeLakeAccessChannel(channel: LakeAccessChannel): string {
  const detail = describeChannelDetail(channel);
  const label = CHANNEL_KIND_LABEL[channel.kind];
  return detail ? `${label}: ${detail}` : label;
}

/**
 * Whether a lake's access channels compose CONJUNCTIVELY - i.e. they are NOT independent read paths.
 * The read gate (assertLakeAccess) treats an organization channel as a hard prerequisite, and keeps
 * any tag/entitlement requirement in force even for a public lake. So when an org channel appears
 * alongside any other channel, or a public channel appears with a tag/entitlement, effective access
 * is the INTERSECTION of the channels, not their union - and a per-channel `holderCount` is then an
 * upper bound on that one channel, not the reachable set. Presentation surfaces (the access modal,
 * the CSV export) use this to warn the reader rather than imply each channel is a standalone path.
 *
 * Must stay aligned with `assertLakeAccess`: org is AND-composed, tag/entitlement are OR among
 * themselves, and public does not bypass a tag/entitlement gate.
 */
export function lakeAccessChannelsComposeConjunctively(channels: LakeAccessChannel[]): boolean {
  const kinds = new Set(channels.map(c => c.kind));
  const hasNarrowing = kinds.has('tag') || kinds.has('entitlement');
  return (kinds.has('organization') && channels.length > 1) || (kinds.has('public') && hasNarrowing);
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
  /**
   * Per-principal read aggregation from the access-audit events. Always a LOWER BOUND on reads, and
   * presentation surfaces must say so. Three reasons, all structural rather than temporary:
   * an event exists only for a retrieval surface instrumented to emit one; the write is
   * deliberately best-effort (`recordLakeAccessEvent` swallows its own failures so no user response
   * depends on the audit write, and several call sites do not await it); and events age out on
   * their own retention TTL. An empty `history` therefore means "no reads recorded", never "nobody
   * read this lake" - stating the stronger claim would be the false reassurance a compliance reader
   * has no way to detect.
   */
  history: LakeAccessHistoryEntry[];
  /** True when the audit read hit its cap: `history` is then the most-recent window, not the whole
   * trail. Surfaced so an owner is never misled into reading a capped view as complete. Note that even
   * an UNtruncated view is only "complete within retention" - access events expire on their own TTL. */
  historyTruncated: boolean;
  /**
   * The start of the audit window the per-row aggregates cover, set ONLY when `historyTruncated`.
   * When truncated, each history row's `readCount`/`firstAccessedAt` describe reads AT OR AFTER this
   * instant, not all-time - so a consumer (JSON or CSV) can qualify those numbers rather than read
   * them as absolute. Absent when the window is the whole retained trail. */
  windowStartsAt?: Date;
  /** When the view was assembled - the instant grant expiry (`status`) was resolved against. */
  generatedAt: Date;
}

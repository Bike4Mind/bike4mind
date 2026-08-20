import type {
  IDataLakeAccessGrantDocument,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  ILakeAccessEventDocument,
  ILakeAccessEventRepository,
  IOrganizationRepository,
  IUserRepository,
  LakeAccessChannel,
  LakeAccessGrantView,
  LakeAccessHistoryEntry,
  LakeAccessSurface,
  LakeAccessView,
  LakeGrantStatus,
} from '@bike4mind/common';
import { ORG_MEMBERSHIP_ACL_PERMISSIONS } from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils';

/** Default cap on audit events read for the history aggregation - see `historyTruncated`. */
export const LAKE_ACCESS_VIEW_HISTORY_LIMIT = 2000;

/**
 * The org `users[]` permissions that count as membership, DERIVED from the one shared definition
 * rather than hand-copied: the org channel's `holderCount` must count exactly the members the DB gate
 * (`OrganizationModel`'s `findMembershipOrgIds`) would admit, or an owner is shown a member total
 * larger than the set that can actually read - false reassurance a compliance reader cannot detect.
 */
const ORG_MEMBER_PERMISSIONS = new Set<string>(ORG_MEMBERSHIP_ACL_PERMISSIONS);

/**
 * Whether a grant is live at `now`. IDENTICAL boundary to the DB `buildActiveGrantFilter` and the
 * read gate: active when there is no expiry OR the expiry is strictly after `now`; expired the
 * instant `expiresAt <= now`. Kept in lockstep on purpose - a view that called a grant `active`
 * one tick after the gate began denying it would be exactly the "renders a stored row as live"
 * failure #1672 names.
 */
export function classifyGrantStatus(expiresAt: Date | null | undefined, now: Date): LakeGrantStatus {
  return expiresAt != null && expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

/**
 * The gate-based read paths (NOT explicit grant rows) that a lake exposes, derived purely from its
 * gate config. Tag/entitlement/org/public are resolved live on every request and never materialized,
 * so they belong here as channels rather than as membership rows. Order is stable (tag, entitlement,
 * org, public) so the export is deterministic. Holder counts are enriched later, only where cheap.
 */
export function deriveAccessChannels(
  lake: Pick<IDataLakeDocument, 'organizationId' | 'requiredUserTag' | 'requiredEntitlement' | 'isPublic'>
): LakeAccessChannel[] {
  const channels: LakeAccessChannel[] = [];
  if (lake.requiredUserTag) channels.push({ kind: 'tag', value: lake.requiredUserTag });
  if (lake.requiredEntitlement) channels.push({ kind: 'entitlement', value: lake.requiredEntitlement });
  const orgId = normalizeId(lake.organizationId);
  if (orgId) channels.push({ kind: 'organization', value: orgId });
  if (lake.isPublic) channels.push({ kind: 'public' });
  return channels;
}

/**
 * Collapse raw per-call audit events into one row per principal: read count, first/last access, and
 * the distinct surfaces used. Events are grouped by the acting principal (kind + id), NOT by
 * `onBehalfOfUserId` - the acting identity is what "who read this" asks for; the on-behalf human is
 * carried through for display when a single principal has one. Pure over the event list.
 *
 * Sorted most-recently-active first so the busiest/most-recent readers head the compliance view.
 */
export function aggregateAccessHistory(
  events: Pick<
    ILakeAccessEventDocument,
    'principalKind' | 'principalId' | 'onBehalfOfUserId' | 'surface' | 'createdAt'
  >[]
): LakeAccessHistoryEntry[] {
  const byPrincipal = new Map<string, { entry: LakeAccessHistoryEntry; surfaces: Set<LakeAccessSurface> }>();
  for (const event of events) {
    const key = `${event.principalKind}:${event.principalId}`;
    const at = event.createdAt;
    const acc = byPrincipal.get(key);
    if (!acc) {
      byPrincipal.set(key, {
        entry: {
          principalKind: event.principalKind,
          principalId: event.principalId,
          onBehalfOfUserId: event.onBehalfOfUserId,
          readCount: 1,
          lastAccessedAt: at,
          firstAccessedAt: at,
          surfaces: [],
        },
        surfaces: new Set([event.surface]),
      });
      continue;
    }
    const { entry } = acc;
    entry.readCount += 1;
    if (at.getTime() > entry.lastAccessedAt.getTime()) entry.lastAccessedAt = at;
    if (at.getTime() < entry.firstAccessedAt.getTime()) entry.firstAccessedAt = at;
    // Keep the first on-behalf human seen; a principal reading for several humans is rare and the
    // per-event trail retains the rest. Prefer any present value over an earlier undefined.
    if (!entry.onBehalfOfUserId && event.onBehalfOfUserId) entry.onBehalfOfUserId = event.onBehalfOfUserId;
    acc.surfaces.add(event.surface);
  }
  return Array.from(byPrincipal.values())
    .map(({ entry, surfaces }) => ({ ...entry, surfaces: Array.from(surfaces).sort() }))
    .sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime());
}

export interface AssembleLakeAccessViewAdapters {
  db: {
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    lakeAccessEvents: Pick<ILakeAccessEventRepository, 'listByLake'>;
    users: Pick<IUserRepository, 'findByIds'>;
    organizations: Pick<IOrganizationRepository, 'findById'>;
  };
  /** Cap on audit events read for the aggregation. Defaults to LAKE_ACCESS_VIEW_HISTORY_LIMIT. */
  historyLimit?: number;
  /** Injectable clock so grant-status resolution is deterministic in tests. Defaults to now. */
  now?: Date;
}

/**
 * A display name for a user, best-effort: real name, else username, else undefined. Deliberately
 * does NOT fall back to email: this view resolves arbitrary principal ids (a public/tag-gated lake
 * accumulates readers across tenants), and leaking an email as a "name" into a manager's export
 * would disclose a cross-tenant identity the manager was never meant to see. An unresolved user
 * shows as its opaque id, not its address.
 */
const userDisplayName = (u: { name?: string; username?: string } | undefined): string | undefined =>
  u ? u.name || u.username || undefined : undefined;

/**
 * Assemble the owner-facing access & membership view (#1672) for one already-resolved, manage-gated
 * lake. Read-only: it never writes a grant or an event.
 *
 * Combines three sources into one exportable artifact:
 *  1. `grants`   - every persisted grant row (INCLUDING lapsed ones), each tagged active/expired at
 *                  read time so a revoked-by-expiry grant is never shown as live.
 *  2. `channels` - the gate-based read paths (tag/entitlement/org/public), resolved live, surfaced
 *                  as channels rather than fake rows. The org channel is enriched with a member count.
 *  3. `history`  - per-principal aggregation of the access-audit trail (#1663).
 *
 * The CALLER owns authorization: it must resolve the lake and confirm the actor can manage it
 * before calling this (the view exposes who-read-what, which is manager-only). This function assumes
 * that gate has already passed.
 */
export async function assembleLakeAccessView(
  lake: Pick<
    IDataLakeDocument,
    'id' | 'name' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement' | 'isPublic'
  >,
  { db, historyLimit = LAKE_ACCESS_VIEW_HISTORY_LIMIT, now = new Date() }: AssembleLakeAccessViewAdapters
): Promise<LakeAccessView> {
  // All-grants read (no activeAsOf): the view must render lapsed rows too, tagging each active/expired.
  const [grantRows, events] = await Promise.all([
    db.dataLakeAccessGrants.listByLake(lake.id),
    db.lakeAccessEvents.listByLake(lake.id, { limit: historyLimit }),
  ]);

  const history = aggregateAccessHistory(events);
  const channels = deriveAccessChannels(lake);

  // One batched name resolution across every user id the view references: user-principal grants,
  // every grant's granter, and user/on-behalf principals in the history.
  const userIds = new Set<string>();
  for (const g of grantRows) {
    if (g.principalType === 'user') userIds.add(g.principalId);
    if (g.grantedByUserId) userIds.add(g.grantedByUserId);
  }
  for (const h of history) {
    if (h.principalKind === 'user') userIds.add(h.principalId);
    if (h.onBehalfOfUserId) userIds.add(h.onBehalfOfUserId);
  }
  // A history row can carry a non-ObjectId principal/on-behalf id (a Slack id, an agent handle).
  // findByIds drops the id-invalid ones rather than throwing in convertId (which would 500 the whole
  // view); such principals simply render as their opaque id, the honest fallback.
  const users = userIds.size > 0 ? await db.users.findByIds(Array.from(userIds)) : [];
  const userNameById = new Map(users.map(u => [u.id, userDisplayName(u)]));

  // Org names for org-principal grants AND the org channel. Distinct set, one findById each (bounded
  // by how many orgs a lake references - normally 0 or 1). Also compute the org channel member count.
  const orgIds = new Set<string>();
  for (const g of grantRows) if (g.principalType === 'organization') orgIds.add(g.principalId);
  const orgChannel = channels.find(c => c.kind === 'organization');
  if (orgChannel?.value) orgIds.add(orgChannel.value);
  const orgById = new Map(
    await Promise.all(
      Array.from(orgIds).map(async id => [id, await db.organizations.findById(id).catch(() => null)] as const)
    )
  );

  if (orgChannel?.value) {
    const org = orgById.get(orgChannel.value);
    if (org) {
      orgChannel.label = org.name;
      // Members = the billing owner plus the users[] entries the gate would ADMIT (read/write
      // permission), de-duplicated - see ORG_MEMBER_PERMISSIONS. Counting the raw ACL would overstate
      // the total by including share-only members the gate denies, and an over-stated count is exactly
      // the kind of false reassurance a compliance reader cannot detect.
      const admitted = (org.users ?? []).filter(
        u => u.userId && (u.permissions ?? []).some(p => ORG_MEMBER_PERMISSIONS.has(p))
      );
      const memberIds = new Set<string>([org.userId, ...admitted.map(u => u.userId)].filter(Boolean));
      orgChannel.holderCount = memberIds.size;
    }
  }

  // When the audit read hit the cap, the per-row aggregates only cover the fetched window. Events
  // come back newest-first, so the oldest fetched event is the window's start - carried so a consumer
  // can qualify readCount/firstAccessedAt rather than present them as all-time.
  const historyTruncated = events.length >= historyLimit;
  const windowStartsAt = historyTruncated ? events[events.length - 1]?.createdAt : undefined;

  const grants: LakeAccessGrantView[] = grantRows.map((g: IDataLakeAccessGrantDocument) => ({
    principalType: g.principalType,
    principalId: g.principalId,
    principalName: g.principalType === 'user' ? userNameById.get(g.principalId) : orgById.get(g.principalId)?.name,
    role: g.role,
    grantedByUserId: g.grantedByUserId,
    grantedByName: userNameById.get(g.grantedByUserId),
    grantedAt: g.createdAt,
    expiresAt: g.expiresAt ?? null,
    status: classifyGrantStatus(g.expiresAt, now),
  }));

  return {
    lakeId: lake.id,
    lakeName: lake.name,
    grants,
    channels,
    history: history.map(h => ({
      ...h,
      principalName: h.principalKind === 'user' ? userNameById.get(h.principalId) : undefined,
      onBehalfOfName: h.onBehalfOfUserId ? userNameById.get(h.onBehalfOfUserId) : undefined,
    })),
    historyTruncated,
    windowStartsAt,
    generatedAt: now,
  };
}

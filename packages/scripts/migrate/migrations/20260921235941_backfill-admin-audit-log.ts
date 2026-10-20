import type { Types } from 'mongoose';
import {
  ADMIN_AUDIT_CATALOGUE,
  type AdminAuditAction,
  type AuditActor,
  type AuditContext,
  type AuditChange,
  type AuditTarget,
  type NewAdminAuditEntry,
} from '@bike4mind/common';
import { CounterLog, CreditTransaction, User, adminAuditLogRepository } from '@bike4mind/database';
import { adminAuditService } from '@bike4mind/services';
import { type MigrationFile } from './index';

const LOG = '[backfill-admin-audit-log]';
const BATCH_SIZE = 500;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export type BackfillEntry = NewAdminAuditEntry & { id: string };
type IdLike = { toString(): string };
type Metadata = Record<string, unknown>;

export type ActorUser = {
  _id: IdLike;
  name?: string | null;
  username?: string | null;
  email?: string | null;
  isAdmin?: boolean;
};

export type LedgerRow = {
  _id: IdLike;
  type: string;
  ownerId?: string;
  userId?: string;
  credits?: number;
  metadata?: unknown;
  createdAt: Date;
};

export type CounterLogRow = {
  _id: IdLike;
  userId: string;
  counterName: string;
  datetime: Date;
  metadata?: unknown;
};

const isRecord = (value: unknown): value is Metadata =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// Same shape as systemAuditActor() in apps/client/server/utils/adminAudit.ts (scripts cannot import apps/client).
const systemActorNamed = (name: string): AuditActor => ({ kind: 'system', scope: 'platform', name, wasAdmin: false });

const UNKNOWN_ACTOR: AuditActor = {
  kind: 'system',
  scope: 'platform',
  name: 'Unknown (pre-audit)',
  wasAdmin: false,
};

const toUserActor = (user: ActorUser, scope: AuditActor['scope']): AuditActor => {
  const userId = user._id.toString();
  return {
    kind: 'user',
    scope,
    userId,
    ...(user.email ? { email: user.email } : {}),
    name: user.name || user.username || user.email || userId,
    wasAdmin: user.isAdmin === true,
  };
};

export const mapLedgerRowToEntry = (row: LedgerRow, actorUser: ActorUser | null): BackfillEntry => {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const id = row._id.toString();
  const amount = Math.abs(row.credits ?? 0);
  const previousBalance = asNumber(metadata.previousBalance);
  const resultingBalance = asNumber(metadata.resultingBalance);
  const reason = asString(metadata.note);
  const { category, severity } = ADMIN_AUDIT_CATALOGUE['user.credits.adjusted'];
  const targetId = row.ownerId ?? row.userId ?? '';

  return {
    id,
    occurredAt: row.createdAt,
    action: 'user.credits.adjusted',
    category,
    severity,
    actor: actorUser ? toUserActor(actorUser, 'platform') : UNKNOWN_ACTOR,
    target: { kind: 'user', id: targetId, displayName: targetId },
    summary: row.type === 'generic_deduct' ? `deducted ${amount} credits` : `granted ${amount} credits`,
    ...(reason ? { reason } : {}),
    ...(previousBalance !== undefined && resultingBalance !== undefined
      ? { changes: [{ field: 'currentCredits', before: previousBalance, after: resultingBalance }] }
      : {}),
    context: { source: 'admin_ui' },
    related: { creditTransactionId: id },
    backfilled: true,
  };
};

/**
 * What one old CounterLog event becomes. `consumed` keys are lifted into the target or summary and
 * are dropped from `details`; everything else in the old metadata is kept there.
 */
type ResolvedEvent = {
  action: AdminAuditAction;
  target: AuditTarget;
  summary: string;
  organizationId?: string;
  changes?: AuditChange[];
  consumed?: string[];
  extraDetails?: Metadata;
};

type CounterEventSpec = {
  /** Old call wrote no `adminUserId`; the acting admin was the row's own `userId`. */
  actorFromUserId?: boolean;
  actorScope?: AuditActor['scope'];
  /**
   * For events the live path also records without an acting admin: rows lacking `adminUserId`
   * are backfilled under this actor and `source`, and `adminSource` applies to rows that have one.
   */
  systemActor?: { actor: AuditActor; source: AuditContext['source']; adminSource: AuditContext['source'] };
  resolve: (flat: Metadata, row: CounterLogRow) => ResolvedEvent | null;
};

const ORG_KEYS = ['organizationId', 'organizationName'];

const organizationTarget = (flat: Metadata): AuditTarget | null => {
  const id = asString(flat.organizationId);
  return id ? { kind: 'organization', id, displayName: asString(flat.organizationName) ?? id } : null;
};

const orgEvent =
  (
    action: AdminAuditAction,
    summary: (flat: Metadata) => string,
    options: {
      extra?: (row: CounterLogRow) => Metadata;
      changes?: (flat: Metadata) => AuditChange[] | undefined;
      consumed?: string[];
    } = {}
  ): ((flat: Metadata, row: CounterLogRow) => ResolvedEvent | null) =>
  (flat, row) => {
    const target = organizationTarget(flat);
    if (!target) return null;
    return {
      action,
      target,
      summary: summary(flat),
      changes: options.changes?.(flat),
      consumed: [...ORG_KEYS, ...(options.consumed ?? [])],
      extraDetails: options.extra?.(row),
    };
  };

const settingsEvent =
  (action: AdminAuditAction, target: AuditTarget, summary: string): ((flat: Metadata) => ResolvedEvent) =>
  () => ({ action, target, summary });

const SYSTEM_HEALTH_TARGET: AuditTarget = { kind: 'system', id: 'system-health', displayName: 'System health' };

const systemHealthEvent = (summary: (flat: Metadata) => string) => (flat: Metadata) => ({
  action: 'system_health.test_run' as const,
  target: SYSTEM_HEALTH_TARGET,
  summary: summary(flat),
});

const oauthEvent =
  (action: AdminAuditAction, summary: string) =>
  (flat: Metadata): ResolvedEvent | null => {
    const id = asString(flat.oauthClientId);
    if (!id) return null;
    const { oldConfig, newConfig } = flat;
    const changes =
      isRecord(oldConfig) && isRecord(newConfig)
        ? Object.keys(newConfig)
            .filter(field => JSON.stringify(oldConfig[field]) !== JSON.stringify(newConfig[field]))
            .map(field => ({ field, before: oldConfig[field], after: newConfig[field] }))
        : undefined;
    // Configs stay in details unless the changes row carries them, so nothing is lost.
    return {
      action,
      target: { kind: 'oauthClient', id, displayName: asString(flat.name) ?? id },
      summary,
      changes,
      consumed: ['oauthClientId', 'name', ...(changes?.length ? ['oldConfig', 'newConfig'] : [])],
    };
  };

const userEmailEvent =
  (action: AdminAuditAction, summary: string) =>
  (_flat: Metadata, row: CounterLogRow): ResolvedEvent => ({
    action,
    target: { kind: 'user', id: row.userId, displayName: row.userId },
    summary,
  });

const scanScheduleEvent =
  (action: AdminAuditAction, summaryOverride?: string) =>
  (flat: Metadata): ResolvedEvent | null => {
    const scanType = asString(flat.scanType);
    if (!scanType) return null;
    return {
      action,
      target: {
        kind: 'settings',
        id: `security-scan-schedule:${scanType}`,
        displayName: `${scanType} scan schedule`,
      },
      summary:
        summaryOverride ??
        (action === 'settings.security_scan.enabled' ? 'enabled the weekly scan' : 'disabled the weekly scan'),
      consumed: ['scanType'],
    };
  };

const resolveOrgGranted = (flat: Metadata, row: CounterLogRow): ResolvedEvent => {
  const organizationId = asString(flat.organizationId);
  const subscriptionType = asString(flat.subscriptionType);
  // ORG_GRANTED was written by both the org grant route (no subscriptionType) and the per-user
  // grant-subscription route (always has one, and carries organizationId for team grants).
  if (organizationId && !subscriptionType) {
    const seats = asNumber(flat.seats);
    const initialCredits = asNumber(flat.initialCredits);
    return {
      action: 'org.credits.granted',
      target: {
        kind: 'organization',
        id: organizationId,
        displayName: asString(flat.organizationName) ?? organizationId,
      },
      summary:
        seats !== undefined && initialCredits !== undefined
          ? `granted org with ${seats} seats and ${initialCredits} initial credits`
          : 'granted organization',
      consumed: ORG_KEYS,
      extraDetails: { ownerId: row.userId },
    };
  }
  return {
    action: 'user.subscription.granted',
    target: { kind: 'user', id: row.userId, displayName: row.userId },
    summary: subscriptionType ? `granted ${subscriptionType} subscription` : 'granted subscription',
    organizationId,
    consumed: ['organizationId'],
  };
};

const RESTORE_CONFIG_TYPE = 'whats-new-config';

// Mirrors whats-new-config/restore.ts: one `config` change holding the whole before/after config.
const resolveWhatsNewRestore = (flat: Metadata): ResolvedEvent => {
  const { oldConfig, newConfig } = flat;
  const hasConfigs = isRecord(oldConfig) && isRecord(newConfig);
  return {
    action: 'settings.whats_new.updated',
    target: { kind: 'settings', id: 'whats-new-config', displayName: "What's New configuration" },
    summary: 'restored the configuration from history',
    changes: hasConfigs ? [{ field: 'config', before: oldConfig, after: newConfig }] : undefined,
    consumed: ['configType', ...(hasConfigs ? ['oldConfig', 'newConfig', 'changedFields'] : [])],
  };
};

// Mirrors whats-new/config.ts: one `syncConfig` change. The old row's per-field `changes` flags are
// derivable from before/after, so they are dropped only when that change is emitted.
const resolveWhatsNewSyncConfig = (flat: Metadata): ResolvedEvent => {
  const { oldConfig, newConfig } = flat;
  const hasConfigs = isRecord(oldConfig) && isRecord(newConfig);
  return {
    action: 'settings.whats_new.updated',
    target: { kind: 'settings', id: 'whats-new-sync-config', displayName: "What's New sync configuration" },
    summary: 'updated the sync configuration',
    changes: hasConfigs ? [{ field: 'syncConfig', before: oldConfig, after: newConfig }] : undefined,
    consumed: hasConfigs ? ['oldConfig', 'newConfig', 'changes'] : [],
  };
};

const COUNTER_EVENT_SPECS: Record<string, CounterEventSpec> = {
  ORG_GRANTED: { resolve: resolveOrgGranted },
  ORG_TOPPED_UP: {
    resolve: orgEvent(
      'org.credits.topped_up',
      flat => {
        const credits = asNumber(flat.credits);
        return credits !== undefined ? `topped up ${credits} credits` : 'topped up credits';
      },
      { extra: row => ({ ownerId: row.userId }) }
    ),
  },
  ORG_SEATS_CHANGED: {
    resolve: orgEvent(
      'org.seats.changed',
      flat => {
        const previous = asNumber(flat.previousSeats);
        const seats = asNumber(flat.seats);
        if (seats === undefined) return 'changed seats';
        return previous !== undefined ? `changed seats from ${previous} to ${seats}` : `set seats to ${seats}`;
      },
      {
        changes: flat => {
          const previous = asNumber(flat.previousSeats);
          const seats = asNumber(flat.seats);
          return previous !== undefined && seats !== undefined
            ? [{ field: 'seats', before: previous, after: seats }]
            : undefined;
        },
        consumed: ['seats', 'previousSeats'],
      }
    ),
  },
  ORG_SEAT_CEILING_RAISED: {
    systemActor: { actor: systemActorNamed('Seat ceiling'), source: 'worker', adminSource: 'script' },
    resolve: orgEvent(
      'org.seats.ceiling_raised',
      flat => {
        const previous = asNumber(flat.previousSeats);
        const next = asNumber(flat.newSeats);
        return previous !== undefined && next !== undefined
          ? `raised seat ceiling from ${previous} to ${next}`
          : 'raised seat ceiling';
      },
      { extra: row => ({ userId: row.userId }), consumed: ['previousSeats', 'newSeats'] }
    ),
  },
  ORG_CONVERT_INITIATED: {
    resolve: orgEvent('org.conversion.initiated', () => 'initiated conversion to a paid subscription', {
      extra: row => ({ ownerId: row.userId }),
    }),
  },
  ORG_REVOKED: {
    resolve: orgEvent('org.revoked', () => 'revoked admin grant', { extra: row => ({ ownerId: row.userId }) }),
  },
  ORG_GROUP_TYPES_UPDATED: {
    actorFromUserId: true,
    actorScope: 'organization',
    resolve: orgEvent('org.group_types.updated', () => 'updated allowed group types'),
  },
  ORG_ADMINS_UPDATED: {
    actorFromUserId: true,
    actorScope: 'organization',
    resolve: orgEvent('org.admins.updated', flat => {
      const adminUserIds = flat.adminUserIds;
      return Array.isArray(adminUserIds) ? `set ${adminUserIds.length} organization admins` : 'set organization admins';
    }),
  },
  ORG_GROUP_MEMBER_ASSIGNED: {
    actorFromUserId: true,
    actorScope: 'organization',
    resolve: orgEvent('org.group_member.assigned', () => 'assigned a user to a group'),
  },
  ORG_GROUP_MEMBER_UNASSIGNED: {
    actorFromUserId: true,
    actorScope: 'organization',
    resolve: orgEvent('org.group_member.unassigned', () => 'removed a user from a group'),
  },
  ORG_GROUP_INVITE_CREATED: {
    actorFromUserId: true,
    actorScope: 'organization',
    // The old call did not record the organization, so the group is the only anchor available.
    resolve: flat => {
      const groupId = asString(flat.groupId);
      return groupId
        ? {
            action: 'org.invite.created',
            target: { kind: 'system', id: groupId, displayName: 'Group' },
            summary: 'created a group invite',
          }
        : null;
    },
  },
  ORG_MEMBER_CREDIT_BUDGET_UPDATED: {
    actorFromUserId: true,
    actorScope: 'organization',
    resolve: orgEvent('org.member_budget.updated', flat =>
      asString(flat.memberUserId)
        ? 'updated a member credit budget override'
        : 'updated the default member credit budget'
    ),
  },
  WHATS_NEW_CONFIG_UPDATED: {
    actorFromUserId: true,
    resolve: flat =>
      flat.configType === RESTORE_CONFIG_TYPE ? resolveWhatsNewRestore(flat) : resolveWhatsNewSyncConfig(flat),
  },
  WHATS_NEW_SYNC_TRIGGERED: {
    actorFromUserId: true,
    resolve: flat =>
      settingsEvent(
        'settings.whats_new.synced',
        { kind: 'settings', id: 'whats-new-sync', displayName: "What's New sync" },
        flat.type === 'selective_import' ? 'imported selected modals' : 'triggered a manual sync'
      )(flat),
  },
  SECURITY_SCAN_SCHEDULE_ENABLED: {
    actorFromUserId: true,
    // The create branch always logged ENABLED, even for a schedule created with enabled: false
    // (no nextRunAt was computed); undo that mislabel.
    resolve: flat => {
      const createdDisabled = flat.newSchedule === true && (flat.nextRunAt === null || flat.nextRunAt === undefined);
      return scanScheduleEvent(
        createdDisabled ? 'settings.security_scan.disabled' : 'settings.security_scan.enabled',
        createdDisabled ? 'created the weekly scan disabled' : undefined
      )(flat);
    },
  },
  SECURITY_SCAN_SCHEDULE_DISABLED: {
    actorFromUserId: true,
    resolve: scanScheduleEvent('settings.security_scan.disabled'),
  },
  SECURITY_SCAN_SCHEDULE_TRIGGERED: {
    actorFromUserId: true,
    // The scheduler cron also writes this event (userId = schedule creator, which is not an
    // acting admin) and stays on the analytics log; only the manual attack-simulation call moved.
    resolve: flat =>
      flat.scanType === 'attack-simulation' && flat.trigger === 'manual'
        ? {
            action: 'security.attack_simulation.run',
            target: { kind: 'system', id: 'attack-simulation', displayName: 'Attack simulation' },
            summary: 'started a manual attack simulation run',
            consumed: ['scanType'],
          }
        : null,
  },
  ADMIN_DATABASE_TEST: {
    actorFromUserId: true,
    resolve: systemHealthEvent(() => 'tested the database connection'),
  },
  ADMIN_TEST_EMAIL_SENT: { actorFromUserId: true, resolve: systemHealthEvent(() => 'sent a test email') },
  ADMIN_OAUTH_TEST: {
    actorFromUserId: true,
    resolve: systemHealthEvent(flat => {
      const provider = asString(flat.provider);
      return provider ? `tested the ${provider} OAuth provider` : 'tested an OAuth provider';
    }),
  },
  OAUTH_CLIENT_CREATED: {
    actorFromUserId: true,
    resolve: oauthEvent('oauth_client.created', 'created an OAuth client'),
  },
  OAUTH_CLIENT_UPDATED: {
    actorFromUserId: true,
    resolve: oauthEvent('oauth_client.updated', 'updated the OAuth client'),
  },
  OAUTH_CLIENT_ACTIVATED: {
    actorFromUserId: true,
    resolve: oauthEvent('oauth_client.activated', 'activated the OAuth client'),
  },
  OAUTH_CLIENT_DEACTIVATED: {
    actorFromUserId: true,
    resolve: oauthEvent('oauth_client.deactivated', 'deactivated the OAuth client'),
  },
  OAUTH_CLIENT_SECRET_ROTATED: {
    actorFromUserId: true,
    resolve: oauthEvent('oauth_client.secret_rotated', 'rotated the client secret'),
  },
  ADMIN_EMAIL_VERIFIED: { resolve: userEmailEvent('user.email.verified', 'verified email') },
  ADMIN_EMAIL_UNVERIFIED: { resolve: userEmailEvent('user.email.unverified', 'unverified email') },
  ADMIN_VERIFICATION_RESENT: {
    resolve: userEmailEvent('user.email.verification_resent', 'resent email verification'),
  },
  ADMIN_EMAIL_CHANGE_RESENT: {
    resolve: userEmailEvent('user.email.change_resent', 'resent email change verification'),
  },
  // Also written by the user-driven cancel route; those rows have no adminUserId and are skipped, so
  // every backfilled row is the admin resend route's expired-change auto-cancel.
  EMAIL_CHANGE_CANCELLED: {
    resolve: userEmailEvent('user.email.change_cancelled', 'cancelled expired email change'),
  },
};

export const BACKFILLED_COUNTER_NAMES = Object.keys(COUNTER_EVENT_SPECS);

// logAuditEvent stored its own fields at the top level of the counter metadata and the caller's
// free-form `metadata` object nested under `metadata`; flatten both into one view.
const NON_DETAIL_KEYS = new Set(['metadata', 'ip', 'userAgent', 'adminUserId', 'adminUsername', 'reason', 'timestamp']);

const flattenMetadata = (raw: Metadata): Metadata => {
  const topLevel = Object.fromEntries(Object.entries(raw).filter(([key]) => !NON_DETAIL_KEYS.has(key)));
  return { ...topLevel, ...(isRecord(raw.metadata) ? raw.metadata : {}) };
};

/** The acting admin's id for a counter row, or undefined when the row is not a backfillable admin action. */
export const resolveCounterLogActorId = (row: CounterLogRow): string | undefined => {
  const spec = COUNTER_EVENT_SPECS[row.counterName];
  if (!spec) return undefined;
  const raw = isRecord(row.metadata) ? row.metadata : {};
  return asString(raw.adminUserId) ?? (spec.actorFromUserId ? asString(row.userId) : undefined);
};

export const mapCounterLogRowToEntry = (row: CounterLogRow, actorUser: ActorUser | null): BackfillEntry | null => {
  const spec = COUNTER_EVENT_SPECS[row.counterName];
  if (!spec || (!resolveCounterLogActorId(row) && !spec.systemActor)) return null;

  const raw = isRecord(row.metadata) ? row.metadata : {};
  const hasActingUser = resolveCounterLogActorId(row) !== undefined;
  const flat = flattenMetadata(raw);
  const resolved = spec.resolve(flat, row);
  if (!resolved) return null;

  const consumed = new Set(resolved.consumed ?? []);
  const remaining = Object.fromEntries(Object.entries(flat).filter(([key]) => !consumed.has(key)));
  const details = { ...remaining, ...resolved.extraDetails };
  const { category, severity } = ADMIN_AUDIT_CATALOGUE[resolved.action];
  const organizationId =
    resolved.organizationId ?? (resolved.target.kind === 'organization' ? resolved.target.id : undefined);
  const reason = asString(raw.reason);
  const ip = asString(raw.ip);
  const userAgent = asString(raw.userAgent);
  const source = spec.systemActor
    ? hasActingUser
      ? spec.systemActor.adminSource
      : spec.systemActor.source
    : 'admin_ui';

  return {
    id: row._id.toString(),
    occurredAt: row.datetime,
    action: resolved.action,
    category,
    severity,
    actor: hasActingUser
      ? actorUser
        ? toUserActor(actorUser, spec.actorScope ?? 'platform')
        : UNKNOWN_ACTOR
      : (spec.systemActor?.actor ?? UNKNOWN_ACTOR),
    target: resolved.target,
    ...(organizationId ? { organizationId } : {}),
    summary: resolved.summary,
    ...(reason ? { reason } : {}),
    ...(resolved.changes?.length ? { changes: resolved.changes.map(adminAuditService.redactChange) } : {}),
    ...(Object.keys(details).length ? { details: adminAuditService.redactAuditPayload(details) } : {}),
    context: { source, ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) },
    backfilled: true,
  };
};

type SourceRow = { _id: Types.ObjectId };

type SourceDefinition<Row extends SourceRow> = {
  source: string;
  /** Returns the next page after `last` (the final row of the previous page, null for the first page). */
  fetchPage: (last: Row | null) => Promise<Row[]>;
  actorIdOf: (row: Row) => string | undefined;
  mapRow: (row: Row, actorUser: ActorUser | null) => BackfillEntry | null;
};

const loadActors = async (actorIds: Set<string>): Promise<Map<string, ActorUser>> => {
  const validIds = [...actorIds].filter(id => OBJECT_ID_PATTERN.test(id));
  if (validIds.length === 0) return new Map();
  const users = await User.find({ _id: { $in: validIds } })
    .select('name username email isAdmin')
    .lean<ActorUser[]>();
  return new Map(users.map(user => [user._id.toString(), user]));
};

const backfillSource = async <Row extends SourceRow>({
  source,
  fetchPage,
  actorIdOf,
  mapRow,
}: SourceDefinition<Row>): Promise<void> => {
  const totals = { source, scanned: 0, inserted: 0, duplicates: 0, skipped: 0 };
  let last: Row | null = null;

  for (;;) {
    const rows: Row[] = await fetchPage(last);
    if (rows.length === 0) break;

    const actorIds = new Set(rows.map(actorIdOf).filter((id): id is string => id !== undefined));
    const actors = await loadActors(actorIds);
    const entries = rows.flatMap(row => {
      const actorId = actorIdOf(row);
      const entry = mapRow(row, actorId ? (actors.get(actorId) ?? null) : null);
      return entry ? [entry] : [];
    });

    const { inserted, duplicates } = await adminAuditLogRepository.appendBackfill(entries);
    totals.scanned += rows.length;
    totals.inserted += inserted;
    totals.duplicates += duplicates;
    totals.skipped += rows.length - entries.length;

    last = rows[rows.length - 1];
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`${LOG} ${JSON.stringify(totals)}`);
};

const migration: MigrationFile = {
  id: 20260921235941,
  name: 'backfill-admin-audit-log',

  // Idempotent: each entry's id is its source row's _id, so a re-run counts duplicates and writes nothing.
  up: async () => {
    await backfillSource<LedgerRow & SourceRow>({
      source: 'creditTransactions',
      // No CreditTransaction index leads with type/reason (all start with userId/ownerId/stripe ids), so
      // this is an ordered _id-index walk with the filter applied per document.
      fetchPage: last =>
        CreditTransaction.find({
          type: { $in: ['generic_add', 'generic_deduct'] },
          reason: 'admin_adjustment',
          ...(last ? { _id: { $gt: last._id } } : {}),
        })
          .sort({ _id: 1 })
          .limit(BATCH_SIZE)
          .lean<Array<LedgerRow & SourceRow>>(),
      actorIdOf: row => (isRecord(row.metadata) ? asString(row.metadata.actorId) : undefined),
      mapRow: mapLedgerRowToEntry,
    });

    await backfillSource<CounterLogRow & SourceRow>({
      source: 'counterLogs',
      // Uses the { datetime, counterName, userOrganization } index: range on datetime, then counterName.
      // Keyset-paginates on (datetime, _id); rows sharing the last datetime resume after the last _id.
      fetchPage: last =>
        CounterLog.find({
          datetime: { $gte: last?.datetime ?? new Date(0) },
          counterName: { $in: BACKFILLED_COUNTER_NAMES },
          ...(last
            ? { $or: [{ datetime: { $gt: last.datetime } }, { datetime: last.datetime, _id: { $gt: last._id } }] }
            : {}),
        })
          .sort({ datetime: 1, _id: 1 })
          .limit(BATCH_SIZE)
          .lean<Array<CounterLogRow & SourceRow>>(),
      actorIdOf: resolveCounterLogActorId,
      mapRow: mapCounterLogRowToEntry,
    });
  },

  // One-way: the audit log is immutable, and leaving backfilled entries in place loses nothing.
  down: async () => {},
};

export default migration;

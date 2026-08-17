import type {
  IAdminSettingsRepository,
  IDataLakeDocument,
  ILakeConfigChangeEventRepository,
  ILakeConfigFieldChange,
  LakeConfigChangeAction,
  LakeManageRung,
} from '@bike4mind/common';
import { resolveLakeManageRung, type LakeGrant, type ManageActor } from './manageRule';
import { resolveLakeConfigAuditRetention, type LakeConfigAuditLogger } from './resolveLakeConfigAuditRetention';

/**
 * The audit half of a config-write service's adapters. BOTH repositories are optional, and a
 * missing one degrades to "no event recorded" rather than a compile error, for the same reason
 * `GrantReadAdapter.dataLakeAccessGrants` is optional: the config-write services are reached from
 * scripts and migrations that have no reason to wire an audit trail, and forcing every one of them
 * to thread two repositories would be a large, unrelated change to make an audit possible at all.
 * The user-facing routes DO wire them - that is the path this exists for.
 *
 * `adminSettings` absent simply means the retention lever is not read here; `record()` still
 * clamps to the platform floor, so the event lands with the default window rather than none.
 */
export interface LakeConfigAuditAdapters {
  db: {
    lakeConfigChangeEvents?: Pick<ILakeConfigChangeEventRepository, 'record'>;
    adminSettings?: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
  };
  logger?: LakeConfigAuditLogger;
}

export interface RecordLakeConfigChangeParams {
  actor: ManageActor;
  lake: Pick<IDataLakeDocument, 'id' | 'createdByUserId' | 'organizationId'>;
  /** The lake's active grants, if the caller already loaded them for its own gate - passing them
   * is what lets the rung resolve to `grant-owner`/`grant-curator`/`org-grant` rather than
   * collapsing to the creator/org-admin arms. */
  grants?: readonly LakeGrant[];
  action: LakeConfigChangeAction;
  changes: ILakeConfigFieldChange[];
  /**
   * The rung that authorized THIS call, when the caller knows it better than `resolveLakeManageRung`
   * can infer it. Two legitimate uses: a write no principal drove (the `auto-activate` action, which
   * records `system`), and a gate NARROWER than `canManageLake` - `transferLakeOwnership` admits
   * only admin/owner/org-admin, so the resolver's wider ladder could name a curator rung that
   * cannot in fact authorize a transfer.
   *
   * It is not a label to set freely: the rung is an authorization FACT, so an override must come
   * from the branch that actually let the call through, never from what reads best.
   */
  manageRung?: LakeManageRung;
}

/**
 * Record one config-change event, BEST-EFFORT: any failure is logged and swallowed, never thrown.
 *
 * This is the deliberate INVERSE of the read side, and the asymmetry is the point - do not "fix"
 * it into a throw. On a retrieval, the event IS the artifact and the retrieval is repeatable, so
 * losing the event is the expensive outcome. Here the config write is the artifact: it has already
 * landed by the time this runs, so throwing would report a failed reconfiguration that in fact
 * succeeded and invite a retry of a finished operation. Failing loudly in the log, and only there,
 * is the honest middle: an operator can see that a change went unrecorded.
 *
 * Records NOTHING when `changes` is empty. A write that moved no value is not a change, and a
 * history that listed it would put a line in an owner's audit for something that never altered how
 * their lake answers. Callers therefore do not need to guard the call site.
 */
export async function recordLakeConfigChange(
  { actor, lake, grants = [], action, changes, manageRung }: RecordLakeConfigChangeParams,
  { db, logger }: LakeConfigAuditAdapters
): Promise<void> {
  if (changes.length === 0) return;
  const events = db.lakeConfigChangeEvents;
  if (!events) return;

  // Falls back to console when no logger is wired, so a swallowed failure cannot go fully silent -
  // the only other symptom is a config change missing from a history nobody is reading yet. Called
  // through a closure rather than by reference so a logger whose method needs `this` still works.
  const warn = (msg: string, meta: unknown) => (logger?.warn ? logger.warn(msg, meta) : console.warn(msg, meta));

  try {
    const retentionDays = db.adminSettings
      ? await resolveLakeConfigAuditRetention({ adminSettings: db.adminSettings }, { logger })
      : undefined;

    await events.record({
      // A blank actor id means no principal drove this write (a script, a migration, the
      // auto-activate path), which is a `system` event rather than a user event with a lost id -
      // the same call the actor stamp makes when it emits no key at all.
      principalKind: actor.userId ? 'user' : 'system',
      principalId: actor.userId || 'system',
      organizationId: lake.organizationId || undefined,
      dataLakeId: lake.id,
      // `system` rather than a guess when the rung will not resolve: the gate has already passed by
      // the time this runs, so a null here means the caller authorized on a narrower rule of its
      // own (or on no principal at all), and inventing a rung would be the one field in this row
      // that lied.
      manageRung: manageRung ?? resolveLakeManageRung(lake, actor, grants) ?? 'system',
      action,
      changes,
      retentionDays,
    });
  } catch (err) {
    warn('[dataLakes] lake config changed but the audit event did not persist', {
      dataLakeId: lake.id,
      action,
      err,
    });
  }
}

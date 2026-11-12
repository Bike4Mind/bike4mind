import { canonicalApprovalJson } from '@bike4mind/common';
import { AdminAuditLogModel, AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[stamp-model-access-entries]';
const SETTING_NAME = 'llmModelConfigurations';

type Entry = { id?: unknown; updatedAt?: unknown };
type AuditRow = { occurredAt: Date; changes?: { field: string; before?: unknown; after?: unknown }[] };

const entryById = (list: unknown, id: string): string | undefined => {
  if (!Array.isArray(list)) return undefined;
  const entry = (list as Entry[]).find(item => item?.id === id);
  // Key order differs between writers (the base-entitlement migration appended allowedEntitlements), so it
  // must not read as a change.
  return entry === undefined ? undefined : canonicalApprovalJson(entry);
};

/**
 * Model access writes are conditional on a per-entry `updatedAt` (apps/client/server/modelAccess). Give each
 * entry saved before that its stamp: the newest whole-array save whose audit entry changed that entry, else
 * the document's own updatedAt. Each entry is set only while it is still unstamped, so a run racing a
 * per-model write never overwrites that write's stamp, and a rerun changes nothing.
 */
const migration: MigrationFile = {
  id: 20260921239998,
  name: 'stamp-model-access-entries',

  up: async () => {
    const setting = (await AdminSettings.findOne({ settingName: SETTING_NAME }).lean()) as {
      settingValue?: unknown;
      updatedAt?: Date;
    } | null;
    if (!setting || !Array.isArray(setting.settingValue)) {
      console.log(`${LOG} no access entries - nothing to do`);
      return;
    }
    const unstamped = new Set(
      (setting.settingValue as Entry[])
        .filter(entry => typeof entry?.id === 'string' && !(entry.updatedAt instanceof Date))
        .map(entry => entry.id as string)
    );
    if (unstamped.size === 0) {
      console.log(`${LOG} every entry is stamped - nothing to do`);
      return;
    }

    const stamps = new Map<string, Date>();
    const audits = AdminAuditLogModel.find(
      { action: 'settings.admin_settings.updated', 'target.kind': 'settings', 'target.id': SETTING_NAME },
      { occurredAt: 1, changes: 1 }
    )
      .sort({ occurredAt: -1 })
      .lean()
      .cursor();
    for await (const audit of audits as AsyncIterable<AuditRow>) {
      const change = audit.changes?.find(item => item.field === SETTING_NAME);
      if (!change) continue;
      for (const id of unstamped) {
        if (stamps.has(id)) continue;
        if (entryById(change.before, id) !== entryById(change.after, id)) stamps.set(id, audit.occurredAt);
      }
      if (stamps.size === unstamped.size) break;
    }
    const fallback = setting.updatedAt instanceof Date ? setting.updatedAt : new Date();

    let written = 0;
    for (const id of unstamped) {
      const result = await AdminSettings.updateOne(
        { settingName: SETTING_NAME, settingValue: { $elemMatch: { id, updatedAt: null } } },
        { $set: { 'settingValue.$[entry].updatedAt': stamps.get(id) ?? fallback } },
        { arrayFilters: [{ 'entry.id': id, 'entry.updatedAt': null }] }
      );
      written += result.modifiedCount;
    }
    console.log(`${LOG} stamped ${written} of ${unstamped.size} entries (${stamps.size} from the audit trail)`);
  },

  // Stamps are additive and every reader ignores them.
  down: async () => {},
};

export default migration;

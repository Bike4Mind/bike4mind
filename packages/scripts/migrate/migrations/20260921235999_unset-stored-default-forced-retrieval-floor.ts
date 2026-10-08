import { isBlankSettingValue, SettingScopeLevel, settingsMap } from '@bike4mind/common';
import { AdminSettings, ScopedSetting } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[unset-stored-default-forced-retrieval-floor]';
const SETTING_NAME = 'forcedRetrievalMinSimilarityPct' as const;

/** A stored 75 in any spelling (75, '75', ' 75', '75.0'). Exported for the sibling test. */
export const isStoredDefault = (value: unknown): boolean =>
  (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number(value) === 75;

/**
 * A wider value that leaves the floor per space: blank, schema-invalid (the resolver reads that as
 * unset, e.g. a legacy 0 or a 150), or itself a stored 75. Blank first: the schema parses it into 75.
 */
const isNeutral = (value: unknown): boolean =>
  isBlankSettingValue(value) || !settingsMap[SETTING_NAME].schema.safeParse(value).success || isStoredDefault(value);

type Row = { _id: unknown; settingValue?: unknown };
type ScopedRow = Row & { scopeLevel?: unknown; scopeId?: unknown };

/**
 * `forcedRetrievalMinSimilarityPct` used to read a stored 75 (its declared default) as "unset" and
 * resolve it per embedding space. It now honors a stored 75 in every space, so a row an admin left at
 * 75 - clearing the number field stored exactly that - would start pinning 0.75, which rejects every
 * chunk on text-embedding-3-small. Remove those rows, platform and org/owner overrides alike, so they
 * keep resolving per space.
 *
 * Platform rows are hard-deleted: a soft-deleted platform tombstone would swallow later admin saves,
 * because AdminSettings' upsert does not filter `deletedAt` (see the hardDelete note in
 * apps/client/pages/api/settings/update.ts). Overlay rows are soft-deleted like every other override
 * clear: the audit trail survives, and `upsertOverride`'s explicit `deletedAt: null` filter already
 * excludes the tombstone. Idempotent: a second run removes nothing (it only re-logs kept rows).
 *
 * A scoped 75 is removed only when every wider rung it shadowed is neutral (`isNeutral`), so the
 * scope still resolves per space. The old code tested "75 means unset" on the RESOLVED value, so a
 * winning scoped 75 went per space even over, say, a platform 80; removing it would silently expose
 * that 80. Such a row is kept and logged instead: it now pins 75 in every space, a change too, but it
 * is the admin's explicit value and the log lets an operator choose. An org row's wider rung is the
 * platform row. An owner row can sit under any org the user is in, so it is kept if the platform OR
 * any live org row for this key is non-neutral - conservative, and it needs no membership lookup.
 */
async function removeRows(
  label: string,
  ids: unknown[],
  remove: (filter: Record<string, unknown>) => Promise<{ deletedCount?: number }>
): Promise<void> {
  if (ids.length === 0) return;
  const removed = await remove({ _id: { $in: ids } });
  console.log(`${LOG} removed ${removed.deletedCount ?? 0} stored-75 row(s) from ${label}`);
}

const migration: MigrationFile = {
  id: 20260921235999,
  name: 'unset-stored-default-forced-retrieval-floor',

  up: async () => {
    const filter = { settingName: SETTING_NAME };
    // Read both collections before deleting anything: the keep decision needs the pre-migration values.
    const adminRows: Row[] = await AdminSettings.find(filter).lean();
    const scopedRows: ScopedRow[] = await ScopedSetting.find(filter).lean();

    const platform = adminRows.find(r => !isNeutral(r.settingValue));
    const org = scopedRows.find(r => r.scopeLevel === SettingScopeLevel.Organization && !isNeutral(r.settingValue));
    // The non-neutral value a scoped 75 was shadowing, if any; removing the row would expose it.
    const shadowed = (row: ScopedRow): Row | undefined =>
      platform ?? (row.scopeLevel === SettingScopeLevel.Owner ? org : undefined);

    const scopedIds: unknown[] = [];
    // A blank overlay row parses to the prefaulted 75 and wins, so it is a stored 75 in effect.
    for (const row of scopedRows.filter(r => isStoredDefault(r.settingValue) || isBlankSettingValue(r.settingValue))) {
      // Only org/owner rungs are settableAt for this key; any other row is inert, so removing it is moot.
      const live = row.scopeLevel === SettingScopeLevel.Organization || row.scopeLevel === SettingScopeLevel.Owner;
      const wider = live ? shadowed(row) : undefined;
      if (!wider) {
        scopedIds.push(row._id);
        continue;
      }
      console.log(
        `${LOG} kept ${String(row.scopeLevel)}:${String(row.scopeId)} = 75 over a wider ` +
          `${JSON.stringify(wider.settingValue)}; it now pins 75 in every space - review it`
      );
    }

    // The option is absent from mongoose's DeleteOptions, hence the cast.
    const hard = { hardDelete: true } as Record<string, unknown>;
    await removeRows(
      'adminsettings',
      adminRows.filter(r => isStoredDefault(r.settingValue)).map(r => r._id),
      f => AdminSettings.deleteMany(f, hard)
    );
    // Plain deleteMany: the plugin soft-deletes, matching how clearOverride retires an overlay row.
    await removeRows('scopedsettings', scopedIds, f => ScopedSetting.deleteMany(f));
  },

  // Irreversible by design: every removed row sat over neutral wider rungs, so its scope resolved per
  // embedding space before and after. Kept rows are untouched.
  down: async () => {},
};

export default migration;

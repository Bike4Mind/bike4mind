import type { ToolContext } from '../../base/types';

type ToolDb = ToolContext['db'];

/** Returned whenever a required adapter is missing, so every tool refuses the same way. */
export const NOT_AVAILABLE_MESSAGE =
  'Saving to a data lake is not available on this surface. Tell the user to use the Data Lakes manager instead.';

export const DATA_LAKES_DISABLED_MESSAGE =
  'Data lakes are not enabled on this platform, so nothing can be saved to one. Tell the user so.';

/**
 * The ownership/admin half of whether the assistant may save into a lake, shared by
 * list_my_data_lakes and save_content_to_data_lake. The fallback-lake and LAKE_ATTACHABLE_STATUSES
 * gates are applied separately at each site (listMyDataLakes.ts filter; saveContentToDataLake.ts
 * assertLakeWritable + status check) and must stay in sync, or the list can offer a lake save
 * refuses. A platform admin manages every lake on the platform; the assistant narrows them to lakes they own
 * rather than writing platform-wide on their behalf.
 */
export function isAssistantWriteTarget(lake: { canManage: boolean; isOwn: boolean }, isAdmin: boolean): boolean {
  return lake.canManage && (!isAdmin || lake.isOwn);
}

function hasMethods<T extends object, K extends keyof T>(
  target: T | undefined,
  keys: readonly K[]
): target is T & Required<Pick<T, K>> {
  return !!target && keys.every(key => typeof target[key] === 'function');
}

/**
 * The tools can be offered by the Smart Tools toggle without passing the intent gate, which is
 * where EnableDataLakes is otherwise read (ChatCompletionProcess), so each call re-checks it.
 */
export async function dataLakesEnabled(db: ToolDb): Promise<boolean> {
  return Boolean(await db.adminSettings.getSettingsValue('EnableDataLakes'));
}

export function listLakesAdapters(db: ToolDb) {
  const { dataLakes } = db;
  if (!hasMethods(dataLakes, ['findAccessible'])) return null;
  return { dataLakes, dataLakeAccessGrants: db.dataLakeAccessGrants, organizations: db.organizations };
}

export function createLakeAdapters(db: ToolDb) {
  const { dataLakes, dataLakeAccessGrants, lakeConfigChangeEvents, adminSettings } = db;
  if (!hasMethods(dataLakes, ['create']) || !hasMethods(dataLakeAccessGrants, ['upsertGrant'])) return null;
  // The audit sink stays optional here (unlike saveContentAdapters): a missing one costs only the
  // History row for the create, which is no reason to refuse creating the lake. `adminSettings`
  // rides along so the row gets the configured retention, as with lakeConfigAuditDb.
  return { dataLakes, dataLakeAccessGrants, lakeConfigChangeEvents, adminSettings };
}

/**
 * Everything assertLakeAccessWithGrants + createFabFile + addFileToDataLake read. The audit sinks are
 * optional to those services but required here: a lake write this tool makes must land in the same
 * config/membership trail as one made from the manager (see lakeConfigAuditDb.ts). The entry is
 * attributed to the user even when an API key drove the turn - the key id is not threaded to tools.
 */
export function saveContentAdapters(db: ToolDb) {
  const { dataLakes, dataLakeAccessGrants, fabfiles, users, lakeMembershipRemovals } = db;
  const { lakeConfigChangeEvents, lakeMembershipChangeEvents } = db;
  if (
    !hasMethods(dataLakes, ['findBySlug', 'findBySlugAmongIds', 'setStats', 'activateIfDraft']) ||
    !hasMethods(dataLakeAccessGrants, ['listByLake']) ||
    !fabfiles ||
    !users ||
    !lakeMembershipRemovals ||
    !lakeConfigChangeEvents ||
    !lakeMembershipChangeEvents
  ) {
    return null;
  }
  return {
    dataLakes,
    dataLakeAccessGrants,
    fabFiles: fabfiles,
    users,
    adminSettings: db.adminSettings,
    scopedSettings: db.scopedSettings,
    lakeMembershipRemovals,
    lakeConfigChangeEvents,
    lakeMembershipChangeEvents,
  };
}

/**
 * The status of an HTTPError-shaped value. Duck-typed rather than `instanceof`: common's and
 * utils' error classes are separate copies in the client bundle and are not identity-equal (see
 * the same note in apps/client/server/utils/orgAccess.ts).
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('statusCode' in error)) return undefined;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

/**
 * A 4xx from the lake services carries a message written for the caller ("You do not have
 * permission..."), so it is safe to hand the model. Anything else is logged and summarized, so a
 * driver error or stack never reaches the transcript.
 */
export function describeFailure(error: unknown): string {
  const status = httpStatusOf(error);
  if (error instanceof Error && status !== undefined && status >= 400 && status < 500 && error.message) {
    return error.message;
  }
  return 'an unexpected server error';
}

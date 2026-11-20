import { randomUUID } from 'node:crypto';
import { settingsMap } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';

/**
 * The model access revision: an opaque stamp rewritten after every write to llmModelConfigurations
 * access entries. Open tabs receive the setting row through their adminsettings subscription and
 * refetch ['llm-model-configurations']; GET /api/admin/llm-models/configurations echoes it in
 * MODEL_ACCESS_REVISION_HEADER. Unlike the model-list revision (./modelListRevision.ts) there is no
 * cache row: no server process caches access entries.
 */

export const MODEL_ACCESS_REVISION_SETTING = settingsMap.modelAccessRevision.key;

/** Call once after an access write (or a whole bulk batch) has committed. */
export async function bumpModelAccessRevision(): Promise<string> {
  const revision = randomUUID();
  await AdminSettings.findOneAndUpdate(
    { settingName: MODEL_ACCESS_REVISION_SETTING },
    { $set: { settingValue: revision } },
    { upsert: true }
  );
  return revision;
}

/** The current access revision, or null before the first bump. */
export async function readModelAccessRevision(): Promise<string | null> {
  const row = await AdminSettings.findOne({ settingName: MODEL_ACCESS_REVISION_SETTING }).lean();
  const value = (row as { settingValue?: unknown } | null)?.settingValue;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

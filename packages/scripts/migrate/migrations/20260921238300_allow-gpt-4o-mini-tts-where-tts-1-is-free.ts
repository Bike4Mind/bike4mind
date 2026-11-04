import { AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[allow-gpt-4o-mini-tts-where-tts-1-is-free]';
const SETTING_NAME = 'freeTierAllowedModels';
// Literal ids, not TTS_DEFAULT_MODEL: this migration records one switch and must not follow later ones.
const PREVIOUS_DEFAULT = 'tts-1';
const NEW_DEFAULT = 'gpt-4o-mini-tts';

/**
 * The stored value with NEW_DEFAULT appended when PREVIOUS_DEFAULT is allowlisted and NEW_DEFAULT is
 * not, in the same shape it was stored in (a JSON string or an array). Null when nothing changes,
 * including a value that is neither shape. Exported for the sibling test.
 */
export const withNewTtsDefault = (value: unknown): string | string[] | null => {
  let models: unknown = value;
  if (typeof value === 'string') {
    try {
      models = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(models) || !models.includes(PREVIOUS_DEFAULT) || models.includes(NEW_DEFAULT)) return null;
  const next = [...models, NEW_DEFAULT];
  return typeof value === 'string' ? JSON.stringify(next) : next;
};

/**
 * The OpenAI TTS default moved from tts-1 to gpt-4o-mini-tts (TTS_DEFAULT_MODEL), and free-tier
 * admission matches model ids exactly (modelAdmission.ts isFreeTierModel). Where an admin made tts-1
 * free, extend that to the model TTS now runs, so free users keep speech after the deploy. Updates
 * every row with this settingName, though the loader (loadFreeTierAllowedModels) reads only the
 * platform one. Idempotent.
 */
const migration: MigrationFile = {
  id: 20260921238300,
  name: 'allow-gpt-4o-mini-tts-where-tts-1-is-free',
  up: async () => {
    const rows = await AdminSettings.find({ settingName: SETTING_NAME }).lean();
    for (const row of rows) {
      const next = withNewTtsDefault(row.settingValue);
      if (next === null) continue;
      await AdminSettings.updateOne({ _id: row._id }, { $set: { settingValue: next } });
      console.log(`${LOG} added ${NEW_DEFAULT} to ${SETTING_NAME}`);
    }
  },
  // Keep the entry: by the time this runs back, an admin may rely on it.
  down: async () => {},
};

export default migration;

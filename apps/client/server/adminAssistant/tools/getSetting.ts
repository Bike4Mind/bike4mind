import {
  allSettingDefinitions,
  redactSettingSecrets,
  resolveSettingDefinition,
  type SettingDefinition,
  type SettingKey,
} from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { z } from 'zod';
import { defineAdminTool } from '../defineAdminTool';

const MAX_SEARCH_RESULTS = 20;
// Some settings hold long prompts or large config objects; past this, send a truncated JSON preview.
const MAX_VALUE_CHARS = 4_000;

const GetSettingInput = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('The exact setting key, e.g. enforceCredits. Provide exactly one of key or search; omit the other.'),
    search: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .describe(
        'Words to find settings by, matched case-insensitively against key, name and description. Returns keys without values. Provide exactly one of key or search; omit the other.'
      ),
  })
  .refine(input => (input.key === undefined) !== (input.search === undefined), {
    message: 'Provide exactly one of key or search',
  });

// Every value leaves through redactSettingSecrets, so a sensitive setting is only ever a mask.
const redacted = (key: string, value: unknown): unknown =>
  redactSettingSecrets({ settingName: key, settingValue: value }).settingValue;

const bounded = (value: unknown) => {
  const json = JSON.stringify(value) ?? 'null';
  if (json.length <= MAX_VALUE_CHARS) return { value, truncatedPreview: null };
  return { value: null, truncatedPreview: json.slice(0, MAX_VALUE_CHARS) };
};

const searchSettings = (search: string) => {
  const needle = search.toLowerCase();
  const matches = allSettingDefinitions().filter(definition =>
    [definition.key, definition.name, definition.description].some(text => text?.toLowerCase().includes(needle))
  );
  return {
    ok: true as const,
    data: {
      search,
      settings: matches.slice(0, MAX_SEARCH_RESULTS).map(({ key, name, category, description }) => ({
        key,
        name,
        category: category ?? null,
        description,
      })),
      truncated: matches.length > MAX_SEARCH_RESULTS,
    },
  };
};

const readSetting = async (definition: SettingDefinition<string>) => {
  const { key } = definition;
  const stored = await adminSettingsRepository.findOne({ settingName: key });
  // getSettingsValue applies the schema, the default fallback and any lock, so it is the value the
  // platform actually runs with; the cast covers contributed keys outside the core SettingKey union.
  const effective = await adminSettingsRepository.getSettingsValue(key as SettingKey);
  const usingDefault = !stored || !definition.schema.safeParse(stored.settingValue).success;

  return {
    ok: true as const,
    data: {
      key,
      name: definition.name,
      category: definition.category ?? null,
      description: definition.description,
      type: definition.type,
      isSensitive: definition.isSensitive === true,
      ...bounded(redacted(key, effective)),
      usingDefault,
    },
  };
};

export const getSettingTool = defineAdminTool({
  name: 'admin_get_setting',
  description:
    'Read an admin setting from the Admin Settings tab. With key: its name, category, description, type, the value currently in effect (a truncated JSON preview when very large) and whether that is the default. Sensitive values (API keys, secrets) come back masked. With search: up to 20 matching setting keys and descriptions, without values, to find the key to read.',
  input: GetSettingInput,
  run: async ({ key, search }) => {
    if (search !== undefined) return searchSettings(search);

    const definition = key === undefined ? undefined : resolveSettingDefinition(key);
    if (!definition) {
      return { ok: false, error: 'not_found', message: 'No setting has that key. Use search to find the key.' };
    }
    return readSetting(definition);
  },
});

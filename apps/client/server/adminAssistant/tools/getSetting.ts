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

// Models often fill an unused optional parameter with '', so it counts as omitted.
const isGiven = (value: string | undefined): value is string => typeof value === 'string' && value !== '';

const GetSettingInput = z
  .object({
    key: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe('The exact setting key, e.g. enforceCredits. Provide exactly one of key or search; omit the other.'),
    search: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe(
        'Words to find settings by; a setting matches when every word appears in its key, name or description (case-insensitive). Returns keys without values. Provide exactly one of key or search; omit the other.'
      ),
  })
  .refine(input => isGiven(input.key) !== isGiven(input.search), {
    message: 'Provide exactly one of key or search',
  });

// Every value leaves through redactSettingSecrets, so a sensitive setting is only ever a mask.
const redacted = (key: string, value: unknown): unknown =>
  redactSettingSecrets({ settingName: key, settingValue: value }).settingValue;

const bounded = (value: unknown) => {
  const json = JSON.stringify(value);
  if (json === undefined) return { value: null, truncatedPreview: null };
  if (json.length <= MAX_VALUE_CHARS) return { value, truncatedPreview: null };
  return { value: null, truncatedPreview: json.slice(0, MAX_VALUE_CHARS) };
};

const searchSettings = (search: string) => {
  const words = search.toLowerCase().split(/\s+/);
  const matches = allSettingDefinitions().filter(definition => {
    const haystack = [definition.key, definition.name, definition.description].join(' ').toLowerCase();
    return words.every(word => haystack.includes(word));
  });
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
  // The platform-level value; the cast covers contributed keys outside the core SettingKey union.
  const { value, source } = await adminSettingsRepository.getSettingsValueWithSource(key as SettingKey);

  return {
    ok: true as const,
    data: {
      key,
      name: definition.name,
      category: definition.category ?? null,
      description: definition.description,
      type: definition.type,
      isSensitive: definition.isSensitive === true,
      ...bounded(redacted(key, value)),
      source,
      overridableAt: definition.scope?.settableAt ?? [],
    },
  };
};

export const getSettingTool = defineAdminTool({
  name: 'admin_get_setting',
  description:
    "Read an admin setting from the Admin Settings tab. With key: its name, category, description, type, the platform-level value (a truncated JSON preview when very large), its source: 'stored', 'default' (nothing valid stored), or 'locked' (forced by the platform whatever is stored), and overridableAt: the scopes (organization, owner, lake) that can override it, so for a non-empty list the value for a given org, user or lake may differ. Sensitive values (API keys, secrets) come back masked. With search: up to 20 matching setting keys and descriptions, without values, to find the key to read.",
  input: GetSettingInput,
  run: async ({ key, search }) => {
    if (isGiven(search)) return searchSettings(search);

    const definition = isGiven(key) ? resolveSettingDefinition(key) : undefined;
    if (!definition) {
      return { ok: false, error: 'not_found', message: 'No setting has that key. Use search to find the key.' };
    }
    return readSetting(definition);
  },
});

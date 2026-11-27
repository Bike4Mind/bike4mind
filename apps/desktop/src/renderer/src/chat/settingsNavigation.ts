import { isImportKind, type ClaudeImportKind } from '@shared/claudeImport';

/** The pages of Settings, in the order the side nav lists them. About is pinned below the rest. */
export const SETTINGS_SECTIONS = [
  'general',
  'notifications',
  'agents',
  'models',
  'permissions',
  'privacy',
  'advanced',
  'about',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection);
}

export const SECTION_LABEL: Record<SettingsSection, string> = {
  general: 'General',
  notifications: 'Notifications and sounds',
  agents: 'Agents and code',
  models: 'Models',
  permissions: 'Permissions',
  privacy: 'Data and privacy',
  advanced: 'Advanced',
  about: 'About and updates',
};

/** One line under each page heading. Permissions has none: its own summary says it better. */
export const SECTION_INTRO: Record<Exclude<SettingsSection, 'permissions'>, string> = {
  general: 'How the app looks and how the sidebar behaves.',
  notifications: 'When the app gets your attention, and how.',
  agents: 'How agents start, where they work, and how far they go on their own.',
  models: 'Local model servers and how replies are shown.',
  privacy: 'What stays on this device, and moving data in and out.',
  advanced: 'For troubleshooting and development.',
  about: 'Your version, updates, and what changed.',
};

/**
 * Which page shows each setting, in page order. Must list every entry `useSettingsEntries` builds:
 * SettingsPanel.test.tsx fails on one that is missing, and the screen shows a stray one on Advanced.
 */
export const PAGE_ENTRIES = {
  general: ['launch-place', 'appearance', 'menu-bar', 'prompt-suggestions', 'nested-sessions', 'pr-attention-sort'],
  notifications: ['notify-scope', 'orchestrator-sound', 'orchestrator-sound-mix'],
  agents: ['spawn-location', 'worktree-default', 'autofix-attempts', 'turn-extensions', 'orchestration-policy'],
  models: ['reply-stats', 'local-context', 'curated-list', 'model-servers'],
  permissions: ['permissions'],
  privacy: ['local-history', 'local-data-export', 'claude-import'],
  advanced: ['server', 'worktrees', 'dollar-costs'],
  about: ['updates'],
} as const satisfies Record<SettingsSection, readonly string[]>;

export type SettingId = (typeof PAGE_ENTRIES)[SettingsSection][number];

const SECTION_OF = new Map<string, SettingsSection>(
  SETTINGS_SECTIONS.flatMap(section => PAGE_ENTRIES[section].map(id => [id, section] as const))
);

export function isSettingId(value: unknown): value is SettingId {
  return typeof value === 'string' && SECTION_OF.has(value);
}

export function sectionOfSetting(id: string): SettingsSection | undefined {
  return SECTION_OF.get(id);
}

/** Plain words a user might search for that the label and description do not say. */
export const SETTING_KEYWORDS: Record<SettingId, string> = {
  'launch-place': 'startup open launch start studio code chat',
  appearance: 'theme dark light mode color colour',
  'menu-bar': 'tray status bar menubar quick approvals tavern',
  'prompt-suggestions': 'suggestion next prompt autocomplete follow up',
  'nested-sessions': 'nest group tree children sub sessions sidebar',
  'pr-attention-sort': 'pull request pr sort order ci conflicts sidebar',
  'notify-scope': 'notification alert badge dock',
  'orchestrator-sound': 'chime audio mute needs you sound',
  'orchestrator-sound-mix': 'volume chime audio sound pack events',
  'spawn-location': 'worktree branch folder new session spawn handoff',
  'worktree-default': 'worktree branch folder git',
  'autofix-attempts': 'auto fix autofix ci retries pull request',
  'turn-extensions': 'long running turn budget credits extend',
  'orchestration-policy': 'worker models orchestrate orchestration upgrade helper',
  'reply-stats': 'speed tokens per second timing statistics',
  'local-context': 'context window memory ram local model length',
  'curated-list': 'refresh catalog curated models list',
  'model-servers': 'ollama llama local llm credentials server endpoint',
  permissions: 'allow deny approve rules access',
  'local-history': 'offline history search device local storage',
  'local-data-export': 'export backup download bundle',
  'claude-import': 'claude migrate import',
  server: 'environment staging url remote backend',
  worktrees: 'worktree branch cleanup disk folder git',
  'dollar-costs': 'price money cost usage dollars',
  updates: 'version upgrade restart install release notes about',
};

/** Old `?section=` values, each now a row on another page. */
const LEGACY_SECTIONS: Record<string, { section: SettingsSection; setting: SettingId }> = {
  servers: { section: 'models', setting: 'model-servers' },
  import: { section: 'privacy', setting: 'claude-import' },
  worktrees: { section: 'advanced', setting: 'worktrees' },
};

export interface SettingsLink {
  section?: SettingsSection;
  /** A row to scroll to and highlight. Always on `section`'s page. */
  setting?: SettingId;
  /** Claude import only: the source to scroll to. */
  focus?: ClaudeImportKind;
}

/**
 * The /settings search params, old spellings included, as the page and row to show.
 *
 * A known `setting` decides the page, since a row lives on exactly one. Otherwise a legacy
 * section maps to the page and row that replaced it.
 */
export function resolveSettingsLink(search: Record<string, unknown>): SettingsLink {
  const focus = isImportKind(search.focus) ? { focus: search.focus } : {};
  if (isSettingId(search.setting)) {
    return { section: SECTION_OF.get(search.setting), setting: search.setting, ...focus };
  }
  if (isSettingsSection(search.section)) return { section: search.section, ...focus };
  const legacy = typeof search.section === 'string' ? LEGACY_SECTIONS[search.section] : undefined;
  if (legacy) return { ...legacy, ...focus };
  return focus;
}

export interface SearchableSetting {
  id: string;
  label: string;
  summary: string;
  description?: string;
}

function searchText(entry: SearchableSetting): string {
  const section = sectionOfSetting(entry.id);
  return [
    entry.label,
    entry.summary,
    entry.description ?? '',
    section ? SECTION_LABEL[section] : '',
    isSettingId(entry.id) ? SETTING_KEYWORDS[entry.id] : '',
  ]
    .join(' ')
    .toLowerCase();
}

/** The entries every word of `query` appears in, case-insensitively, in the order given. */
export function matchSettings<T extends SearchableSetting>(query: string, entries: readonly T[]): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return entries.filter(entry => {
    const text = searchText(entry);
    return words.every(word => text.includes(word));
  });
}

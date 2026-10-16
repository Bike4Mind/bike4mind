import type { SettingKey } from '../schemas/settings';
import type { AuthStrategy } from '../schemas/user';
import type { FabFileSourceType } from '../types/entities/FabFileTypes';
import type { McpServerName } from '../types/entities/McpServerTypes';

/** Display order of the gallery's category groups and filter chips. */
export const INTEGRATION_CATEGORIES = [
  'files',
  'dev-tools',
  'productivity',
  'communication',
  'crm',
  'identity',
  'publishing',
  'import',
  'automation',
  'social',
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const INTEGRATION_CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  files: 'Files',
  'dev-tools': 'Dev tools',
  productivity: 'Productivity',
  communication: 'Communication',
  crm: 'CRM',
  identity: 'Identity',
  publishing: 'Publishing',
  import: 'Import',
  automation: 'Automation',
  social: 'Social',
};

/** `planned` is a roadmap entry: nothing is built behind it. */
export type IntegrationStage = 'ga' | 'beta' | 'planned';

export type IntegrationCapabilityKind =
  'agent-tools' | 'data-lake' | 'webhooks' | 'sign-in' | 'import' | 'notifications' | 'publishing';

/**
 * One thing a brand's integration does. The optional enum links point at the existing
 * identifiers for the same capability, so the client can join against live data (the
 * user's MCP servers, a lake's file sources, a user's auth providers) instead of
 * matching on display strings.
 */
export interface IntegrationCapability {
  id: string;
  label: string;
  kind: IntegrationCapabilityKind;
  stage: IntegrationStage;
  /** Admin flag gating this capability; its `dependsOn` parents gate it too. */
  flag?: SettingKey;
  mcpServer?: McpServerName;
  fabFileSource?: FabFileSourceType;
  authStrategy?: AuthStrategy;
}

/**
 * Who may see an entry at all, beyond flags: `admin` mirrors a surface that only renders
 * for admins, `tavern` mirrors `canAccessTavern` (the Tavern-gated Claude Code bridge).
 */
export type IntegrationAudience = 'admin' | 'tavern';

export interface IntegrationDefinition {
  name: string;
  /** One line, no promises or dates. */
  description: string;
  category: IntegrationCategory;
  logo: IntegrationLogoKey;
  stage: IntegrationStage;
  /** Admin flag gating every capability of the entry. */
  flag?: SettingKey;
  audience?: IntegrationAudience;
  capabilities: readonly IntegrationCapability[];
}

export type ModelProviderKind = 'chat' | 'image' | 'video' | 'music' | 'voice';

export const MODEL_PROVIDER_KIND_LABELS: Record<ModelProviderKind, string> = {
  chat: 'Chat',
  image: 'Image',
  video: 'Video',
  music: 'Music',
  voice: 'Voice',
};

export interface ModelProviderDefinition {
  name: string;
  description: string;
  kind: ModelProviderKind;
  logo: IntegrationLogoKey;
}

/**
 * Every logo the gallery draws. The client maps each key to a brand mark, a monogram or a
 * glyph in one exhaustive table, so adding a key here fails its typecheck until it is drawn.
 */
export const INTEGRATION_LOGO_KEYS = [
  'google-drive',
  'github',
  'atlassian',
  'notion',
  'slack',
  'linkedin',
  'email',
  'jupyter',
  'blog',
  'history-import',
  'google-calendar',
  'okta',
  'claude-code',
  'mcp-cli',
  'b4m-oauth',
  'hubspot',
  'salesforce',
  'gmail',
  'outlook',
  'onedrive-sharepoint',
  'dropbox',
  'box',
  'google-docs-sheets',
  'linear',
  'asana',
  'trello',
  'microsoft-teams',
  'discord',
  'telegram',
  'airtable',
  'zapier',
  'gitlab',
  'bitbucket',
  'openai',
  'anthropic',
  'gemini',
  'xai',
  'deepseek',
  'kimi',
  'bedrock',
  'ollama',
  'flux',
  'veo',
  'lyria',
  'elevenlabs',
] as const;
export type IntegrationLogoKey = (typeof INTEGRATION_LOGO_KEYS)[number];

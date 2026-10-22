import { AuthStrategy } from '../schemas/user';
import { FabFileSourceType } from '../types/entities/FabFileTypes';
import { McpServerName } from '../types/entities/McpServerTypes';
import type { IntegrationDefinition, ModelProviderDefinition } from './types';

/**
 * The integrations gallery (/integrations), one entry per BRAND with its capabilities inside.
 *
 * Adding an entry: append its id here, then TypeScript forces a declaration in
 * INTEGRATION_CATALOG. The array order is the display order within a category group.
 * A `planned` entry is a roadmap card users can request (see
 * apps/client/pages/api/integrations/requests.ts) - describe what the connector would do,
 * never when.
 */
export const INTEGRATION_IDS = [
  'google-drive',
  'github',
  'jupyter',
  'claude-code',
  'mcp-cli',
  'atlassian',
  'notion',
  'slack',
  'email',
  'linkedin',
  'blog',
  'history-import',
  'okta',
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
] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

const planned = (
  name: string,
  description: string,
  category: IntegrationDefinition['category'],
  logo: IntegrationDefinition['logo']
): IntegrationDefinition => ({ name, description, category, logo, stage: 'planned', capabilities: [] });

export const INTEGRATION_CATALOG: Record<IntegrationId, IntegrationDefinition> = {
  'google-drive': {
    name: 'Google Drive',
    description: 'Attach Drive files to a chat and sync a Drive folder into a data lake.',
    category: 'files',
    logo: 'google-drive',
    stage: 'ga',
    capabilities: [
      { id: 'drive-attach', label: 'Attach Drive files to a chat', kind: 'import', stage: 'ga' },
      {
        id: 'drive-lake',
        label: 'Sync a Drive folder into a data lake',
        kind: 'data-lake',
        stage: 'ga',
        flag: 'EnableDataLakes',
        fabFileSource: FabFileSourceType.GOOGLE_DRIVE,
      },
      {
        id: 'drive-poll',
        label: 'Keep synced folders up to date on a schedule',
        kind: 'data-lake',
        stage: 'beta',
        flag: 'EnableDataLakeDrivePoll',
        fabFileSource: FabFileSourceType.GOOGLE_DRIVE,
      },
    ],
  },
  github: {
    name: 'GitHub',
    description: 'Agents read and write repos, issues and pull requests, and GitHub events reach your agents.',
    category: 'dev-tools',
    logo: 'github',
    stage: 'ga',
    capabilities: [
      {
        id: 'github-tools',
        label: 'Agent tools for repos, issues, pull requests and workflows',
        kind: 'agent-tools',
        stage: 'ga',
        flag: 'EnableMCPServer',
        mcpServer: McpServerName.Github,
      },
      {
        id: 'github-lake',
        label: 'Index a repository into a data lake, read only',
        kind: 'data-lake',
        stage: 'beta',
        flag: 'EnableDataLakeGitHub',
        fabFileSource: FabFileSourceType.GITHUB,
      },
      { id: 'github-webhooks', label: 'Route GitHub webhook events to your agents', kind: 'webhooks', stage: 'ga' },
    ],
  },
  jupyter: {
    name: 'Jupyter',
    description: 'Run notebooks generated in chat on your own local Jupyter server.',
    category: 'dev-tools',
    logo: 'jupyter',
    stage: 'ga',
    capabilities: [{ id: 'jupyter-run', label: 'Run generated notebooks from chat', kind: 'agent-tools', stage: 'ga' }],
  },
  'claude-code': {
    name: 'Claude Code',
    description: 'Pair a local Claude Code session with your agents from the Tavern.',
    category: 'dev-tools',
    logo: 'claude-code',
    stage: 'beta',
    audience: 'tavern',
    capabilities: [
      { id: 'cc-bridge', label: 'Bridge a local Claude Code session', kind: 'agent-tools', stage: 'beta' },
    ],
  },
  'mcp-cli': {
    name: 'MCP via CLI',
    description: 'Connect any MCP server to the Bike4Mind CLI and use its tools in CLI sessions.',
    category: 'dev-tools',
    logo: 'mcp-cli',
    stage: 'ga',
    capabilities: [{ id: 'mcp-cli-tools', label: 'Your MCP servers as CLI tools', kind: 'agent-tools', stage: 'ga' }],
  },
  atlassian: {
    name: 'Jira and Confluence',
    description: 'Agents work Jira issues and Confluence pages, and Jira events notify you.',
    category: 'productivity',
    logo: 'atlassian',
    stage: 'ga',
    capabilities: [
      {
        id: 'atlassian-tools',
        label: 'Agent tools for Jira issues and Confluence pages',
        kind: 'agent-tools',
        stage: 'ga',
        flag: 'EnableMCPServer',
        mcpServer: McpServerName.Atlassian,
      },
      { id: 'jira-webhooks', label: 'Notifications for Jira events', kind: 'webhooks', stage: 'ga' },
    ],
  },
  notion: {
    name: 'Notion',
    description: 'Agents search and edit the Notion pages you allow.',
    category: 'productivity',
    logo: 'notion',
    stage: 'ga',
    capabilities: [
      {
        id: 'notion-tools',
        label: 'Agent tools for Notion pages and databases',
        kind: 'agent-tools',
        stage: 'ga',
        flag: 'EnableMCPServer',
        mcpServer: McpServerName.Notion,
      },
    ],
  },
  slack: {
    name: 'Slack',
    description: 'Chat with Bike4Mind in Slack and send threads and files to a data lake.',
    category: 'communication',
    logo: 'slack',
    stage: 'ga',
    capabilities: [
      { id: 'slack-bot', label: 'Bike4Mind in workspace channels and threads', kind: 'notifications', stage: 'ga' },
      { id: 'slack-link', label: 'Link your Slack user to your account', kind: 'sign-in', stage: 'ga' },
      {
        id: 'slack-lake',
        label: 'Add Slack threads and files to a data lake',
        kind: 'data-lake',
        stage: 'ga',
        flag: 'EnableDataLakeSlackAdd',
        fabFileSource: FabFileSourceType.SLACK,
      },
    ],
  },
  email: {
    name: 'Inbound email',
    description: 'Forward email and attachments to your own Bike4Mind address.',
    category: 'communication',
    logo: 'email',
    stage: 'ga',
    capabilities: [
      { id: 'email-forward', label: 'Forward emails into your notebooks', kind: 'import', stage: 'ga' },
      {
        id: 'email-analysis',
        label: 'AI summary, entities and action items for each email',
        kind: 'import',
        stage: 'ga',
        flag: 'EnableEmailAnalysis',
      },
    ],
  },
  linkedin: {
    name: 'LinkedIn',
    description: 'Agents read your company page and its posts.',
    category: 'social',
    logo: 'linkedin',
    stage: 'beta',
    flag: 'EnableMCPServer',
    capabilities: [
      {
        id: 'linkedin-tools',
        label: 'Agent tools for a company page and its posts',
        kind: 'agent-tools',
        stage: 'beta',
        mcpServer: McpServerName.LinkedIn,
      },
    ],
  },
  blog: {
    name: 'Blog publishing',
    description: 'Draft posts in Bike4Mind and publish them to a connected blog.',
    category: 'publishing',
    logo: 'blog',
    stage: 'ga',
    audience: 'admin',
    capabilities: [{ id: 'blog-publish', label: 'Publish posts to your blog', kind: 'publishing', stage: 'ga' }],
  },
  'history-import': {
    name: 'ChatGPT and Claude history',
    description: 'Import past ChatGPT and Claude conversations as searchable notebooks.',
    category: 'import',
    logo: 'history-import',
    stage: 'ga',
    capabilities: [
      { id: 'import-chatgpt', label: 'Import a ChatGPT export', kind: 'import', stage: 'ga' },
      { id: 'import-claude', label: 'Import a Claude export', kind: 'import', stage: 'ga' },
    ],
  },
  okta: {
    name: 'Okta',
    description: "Sign in with your company's Okta identity.",
    category: 'identity',
    logo: 'okta',
    stage: 'ga',
    capabilities: [
      {
        id: 'okta-sign-in',
        label: 'Sign in with Okta',
        kind: 'sign-in',
        stage: 'ga',
        authStrategy: AuthStrategy.Okta,
      },
    ],
  },
  'b4m-oauth': {
    name: 'Sign in with Bike4Mind',
    description: 'Other apps can sign you in with your Bike4Mind account; you approve each one.',
    category: 'identity',
    logo: 'b4m-oauth',
    stage: 'ga',
    capabilities: [{ id: 'oauth-provider', label: 'Bike4Mind as a sign-in provider', kind: 'sign-in', stage: 'ga' }],
  },
  hubspot: planned('HubSpot', 'Agents read and update contacts, companies and deals.', 'crm', 'hubspot'),
  salesforce: planned(
    'Salesforce',
    'Agents read and update accounts, contacts and opportunities.',
    'crm',
    'salesforce'
  ),
  gmail: planned('Gmail', 'Agents search, read and draft email in your mailbox.', 'communication', 'gmail'),
  outlook: planned(
    'Outlook',
    'Agents search, read and draft email in your Outlook mailbox.',
    'communication',
    'outlook'
  ),
  'onedrive-sharepoint': planned(
    'OneDrive and SharePoint',
    'Attach OneDrive files to a chat and sync a SharePoint library into a data lake.',
    'files',
    'onedrive-sharepoint'
  ),
  dropbox: planned('Dropbox', 'Attach Dropbox files to a chat and sync a folder into a data lake.', 'files', 'dropbox'),
  box: planned('Box', 'Attach Box files to a chat and sync a folder into a data lake.', 'files', 'box'),
  'google-docs-sheets': planned(
    'Google Docs and Sheets',
    'Agents read and edit your Docs and Sheets in place.',
    'files',
    'google-docs-sheets'
  ),
  linear: planned('Linear', 'Agents create, update and triage Linear issues.', 'productivity', 'linear'),
  asana: planned('Asana', 'Agents create and update Asana tasks and projects.', 'productivity', 'asana'),
  trello: planned('Trello', 'Agents create and move cards on your Trello boards.', 'productivity', 'trello'),
  'microsoft-teams': planned(
    'Microsoft Teams',
    'Chat with Bike4Mind in Teams channels and chats.',
    'communication',
    'microsoft-teams'
  ),
  discord: planned('Discord', 'Chat with Bike4Mind in your Discord server.', 'communication', 'discord'),
  telegram: planned('Telegram', 'Chat with Bike4Mind from Telegram.', 'communication', 'telegram'),
  airtable: planned('Airtable', 'Agents read and update records in your Airtable bases.', 'productivity', 'airtable'),
  zapier: planned(
    'Zapier',
    'Trigger Bike4Mind agents from Zaps and send their results onward.',
    'automation',
    'zapier'
  ),
  gitlab: planned('GitLab', 'Agents work GitLab repos, issues and merge requests.', 'dev-tools', 'gitlab'),
  bitbucket: planned('Bitbucket', 'Agents work Bitbucket repos and pull requests.', 'dev-tools', 'bitbucket'),
};

export type Integration = IntegrationDefinition & { id: IntegrationId };

export const INTEGRATIONS: readonly Integration[] = INTEGRATION_IDS.map(id => ({ id, ...INTEGRATION_CATALOG[id] }));

export const PLANNED_INTEGRATION_IDS: readonly IntegrationId[] = INTEGRATIONS.filter(i => i.stage === 'planned').map(
  i => i.id
);

const plannedIdSet: ReadonlySet<string> = new Set(PLANNED_INTEGRATION_IDS);

/** True for a roadmap entry a user may request. */
export const isPlannedIntegrationId = (id: string): id is IntegrationId => plannedIdSet.has(id);

/**
 * The Models tab. Only providers with a wired backend belong here: chat backends in
 * b4m-core/llm-adapters, and the image/video/music/voice catalogs in this package.
 */
export const MODEL_PROVIDER_IDS = [
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
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

const MODEL_PROVIDER_CATALOG: Record<ModelProviderId, ModelProviderDefinition> = {
  openai: { name: 'OpenAI', description: 'GPT chat and reasoning models.', kind: 'chat', logo: 'openai' },
  anthropic: { name: 'Anthropic', description: 'Claude chat models.', kind: 'chat', logo: 'anthropic' },
  gemini: { name: 'Google Gemini', description: 'Gemini chat models.', kind: 'chat', logo: 'gemini' },
  xai: { name: 'xAI', description: 'Grok chat models.', kind: 'chat', logo: 'xai' },
  deepseek: { name: 'DeepSeek', description: 'DeepSeek chat and reasoning models.', kind: 'chat', logo: 'deepseek' },
  kimi: { name: 'Kimi', description: 'Kimi chat models.', kind: 'chat', logo: 'kimi' },
  bedrock: {
    name: 'AWS Bedrock',
    description: 'Hosted models served through AWS Bedrock.',
    kind: 'chat',
    logo: 'bedrock',
  },
  ollama: { name: 'Ollama', description: 'Models served from an Ollama server.', kind: 'chat', logo: 'ollama' },
  flux: { name: 'Flux', description: 'Image generation and editing.', kind: 'image', logo: 'flux' },
  veo: { name: 'Veo', description: 'Video generation.', kind: 'video', logo: 'veo' },
  lyria: { name: 'Lyria', description: 'Music generation.', kind: 'music', logo: 'lyria' },
  elevenlabs: { name: 'ElevenLabs', description: 'Text to speech voices.', kind: 'voice', logo: 'elevenlabs' },
};

export type ModelProvider = ModelProviderDefinition & { id: ModelProviderId };

export const MODEL_PROVIDERS: readonly ModelProvider[] = MODEL_PROVIDER_IDS.map(id => ({
  id,
  ...MODEL_PROVIDER_CATALOG[id],
}));

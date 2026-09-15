import { McpServerName } from '@bike4mind/common';

/**
 * The env fields the Settings form offers per server.
 *
 * MUST STAY IN SYNC with `MCP_SERVER_ENV_KEYS` in `@bike4mind/mcp` - that table is the allowlist
 * the spawned child is built from, so a key offered here but missing there is one the user can
 * fill in and never see take effect. `mcpSettings.test.ts` pins the two together.
 */
export const mcpSettings = {
  [McpServerName.LinkedIn]: {
    envVariables: ['LINKEDIN_ACCESS_TOKEN', 'COMPANY_NAME'],
  },
  [McpServerName.Github]: {
    envVariables: ['GITHUB_ACCESS_TOKEN'],
  },
  [McpServerName.Atlassian]: {
    envVariables: ['ATLASSIAN_ACCESS_TOKEN', 'ATLASSIAN_CLOUD_ID', 'ATLASSIAN_SITE_URL'],
  },
  [McpServerName.Notion]: {
    envVariables: ['NOTION_ACCESS_TOKEN', 'NOTION_WORKSPACE_ID'],
  },
} as const;

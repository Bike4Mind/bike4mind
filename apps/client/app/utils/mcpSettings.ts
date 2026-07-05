import { McpServerName } from '@bike4mind/common';

export const mcpSettings = {
  [McpServerName.LinkedIn]: {
    envVariables: ['LINKEDIN_ACCESS_TOKEN', 'COMPANY_NAME'],
  },
  [McpServerName.Github]: {
    envVariables: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  [McpServerName.Atlassian]: {
    envVariables: ['ATLASSIAN_ACCESS_TOKEN', 'ATLASSIAN_CLOUD_ID', 'ATLASSIAN_SITE_URL'],
  },
  [McpServerName.Notion]: {
    envVariables: ['NOTION_ACCESS_TOKEN', 'NOTION_WORKSPACE_ID'],
  },
} as const;

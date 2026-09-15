type EnvVariableDefinition =
  | string
  | {
      key: string;
      defaultValue?: string;
      fallbackKeys?: string[];
    };

type ServerSettings = {
  envVariables: EnvVariableDefinition[];
};

export const mcpSettings: Record<string, ServerSettings> = {
  linkedin: {
    envVariables: ['LINKEDIN_ACCESS_TOKEN', 'COMPANY_NAME'],
  },
  github: {
    envVariables: ['GITHUB_ACCESS_TOKEN'],
  },
  atlassian: {
    envVariables: ['ATLASSIAN_ACCESS_TOKEN', 'ATLASSIAN_CLOUD_ID', 'ATLASSIAN_SITE_URL'],
  },
  notion: {
    envVariables: ['NOTION_ACCESS_TOKEN', 'NOTION_WORKSPACE_ID'],
  },
};

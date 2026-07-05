import type { RotatableIntegration } from '@bike4mind/common';

export interface IntegrationRow {
  integration: RotatableIntegration;
  label: string;
  isConnected: boolean;
  lastRotationInitiatedAt: Date | string | null | undefined;
}

export interface BuildRowsInput {
  atlassianConnect?: { status?: string } | null;
  slackSettings?: { slackUserId?: string } | null;
  integrationRotation?: {
    github?: { lastRotationInitiatedAt: Date | string; lastRotationReason: string } | null;
    atlassian?: { lastRotationInitiatedAt: Date | string; lastRotationReason: string } | null;
    slack?: { lastRotationInitiatedAt: Date | string; lastRotationReason: string } | null;
  } | null;
}

export function buildRows(
  user: BuildRowsInput | null,
  githubConnected: boolean,
  isGitHubStatusError: boolean
): IntegrationRow[] {
  const isGitHubConnected = isGitHubStatusError ? false : githubConnected;
  const isAtlassianConnected = !!user?.atlassianConnect;
  const isSlackConnected = Boolean(user?.slackSettings?.slackUserId);

  return [
    {
      integration: 'github',
      label: 'GitHub',
      isConnected: isGitHubConnected,
      lastRotationInitiatedAt: user?.integrationRotation?.github?.lastRotationInitiatedAt,
    },
    {
      integration: 'atlassian',
      label: 'Atlassian',
      isConnected: isAtlassianConnected,
      lastRotationInitiatedAt: user?.integrationRotation?.atlassian?.lastRotationInitiatedAt,
    },
    {
      integration: 'slack',
      label: 'Slack',
      isConnected: isSlackConnected,
      lastRotationInitiatedAt: user?.integrationRotation?.slack?.lastRotationInitiatedAt,
    },
  ];
}

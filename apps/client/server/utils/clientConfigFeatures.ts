import type { ClientConfigFeatures, SettingKey } from '@bike4mind/common';

/**
 * Flags whose feature has been removed and whose admin setting no longer exists. They stay in the
 * published response, pinned to `false`, so a client that decodes the flag as required keeps working.
 */
export const RETIRED_CLIENT_CONFIG_FEATURES = {
  quest_master: false,
} as const satisfies Partial<Record<keyof ClientConfigFeatures, false>>;

/**
 * GET /api/v1/client-config feature flag -> the admin master switch that gates it deployment-wide.
 * Only the master switch: the per-user opt-in (`Enable<X>Default` + the user's own preference,
 * see featureMeta in app/hooks/useFeatureEnabled.ts) is not resolved here.
 *
 * Every key must already be readable by any signed-in user (userReadableSettingKeys), so this
 * endpoint never widens what a non-admin can see; v1ClientConfig.test.ts enforces it.
 */
export const CLIENT_CONFIG_FEATURE_SETTINGS: Record<
  Exclude<keyof ClientConfigFeatures, keyof typeof RETIRED_CLIENT_CONFIG_FEATURES>,
  SettingKey
> = {
  agents: 'EnableAgents',
  agent_mode: 'EnableAgentMode',
  artifacts: 'EnableArtifacts',
  data_lakes: 'EnableDataLakes',
  deep_research: 'EnableDeepResearch',
  knowledge_base_search: 'EnableKnowledgeBaseSearch',
  mcp_server: 'EnableMCPServer',
  custom_mcp_connectors: 'EnableCustomMcpConnectors',
  mementos: 'EnableMementos',
  rapid_reply: 'EnableRapidReply',
  research_engine: 'EnableResearchEngine',
  team_plan: 'enableTeamPlan',
  voice_sessions: 'enableVoiceSession',
};

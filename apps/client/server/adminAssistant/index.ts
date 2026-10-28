import type { AdminAssistantToolName } from '@bike4mind/common';
import type { ToolDefinition } from '@bike4mind/services/llm/tools';
import { getUserTool } from './tools/getUser';
import { getUsageSignalsTool } from './tools/getUsageSignals';
import { getUserActivityTool } from './tools/getUserActivity';
import { getUserCreditsTool } from './tools/getUserCredits';
import { getUserFeedbackTool } from './tools/getUserFeedback';

export { defineAdminTool } from './defineAdminTool';
export type { AdminToolResult } from './defineAdminTool';

type AdminToolRegistry = Partial<Record<AdminAssistantToolName, ToolDefinition>>;

// Each admin tool registers itself here.
const ADMIN_TOOL_REGISTRY: AdminToolRegistry = {
  admin_get_usage_signals: getUsageSignalsTool,
  admin_get_user: getUserTool,
  admin_get_user_activity: getUserActivityTool,
  admin_get_user_credits: getUserCreditsTool,
  admin_get_user_feedback: getUserFeedbackTool,
};

/** Definitions to merge into a turn's externalTools; empty unless the loaded user is an admin. */
export function adminAssistantToolDefinitions(user: { isAdmin?: boolean | null }): AdminToolRegistry {
  if (user.isAdmin !== true) return {};
  return { ...ADMIN_TOOL_REGISTRY };
}

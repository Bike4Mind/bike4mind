import type { AdminAssistantToolName } from '@bike4mind/common';
import type { ToolDefinition } from '@bike4mind/services/llm/tools';
import { getUsageSignalsTool } from './tools/getUsageSignals';

export { defineAdminTool } from './defineAdminTool';
export type { AdminToolResult } from './defineAdminTool';

type AdminToolRegistry = Partial<Record<AdminAssistantToolName, ToolDefinition>>;

// Each admin tool registers itself here.
const ADMIN_TOOL_REGISTRY: AdminToolRegistry = {
  admin_get_usage_signals: getUsageSignalsTool,
};

/** Definitions to merge into a turn's externalTools; empty unless the loaded user is an admin. */
export function adminAssistantToolDefinitions(user: { isAdmin?: boolean | null }): AdminToolRegistry {
  if (user.isAdmin !== true) return {};
  return { ...ADMIN_TOOL_REGISTRY };
}

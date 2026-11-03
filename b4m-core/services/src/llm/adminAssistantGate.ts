import { ADMIN_ASSISTANT_TOOL_NAMES, isAdminAssistantGateOpen } from '@bike4mind/common';

export type AdminAssistantToolPlan = { open: boolean; enable: string[]; deny: string[] };

/**
 * Per-turn admin assistant tool plan. Open (admin surface + server-loaded isAdmin === true):
 * offer the admin tools whose definitions the host supplied, plus navigate_view for hand-offs
 * to admin views. Closed: deny every admin tool name so no other channel (request tools,
 * session.enabledTools, sticky auto-adds) can reach the model. Never persisted - see
 * adminAssistant.ts in @bike4mind/common.
 */
export function resolveAdminAssistantTools(input: {
  surface?: string | null;
  isAdmin?: boolean | null;
  availableToolNames: ReadonlySet<string>;
}): AdminAssistantToolPlan {
  if (!isAdminAssistantGateOpen({ surface: input.surface }, { isAdmin: input.isAdmin })) {
    return { open: false, enable: [], deny: [...ADMIN_ASSISTANT_TOOL_NAMES] };
  }
  const available = ADMIN_ASSISTANT_TOOL_NAMES.filter(name => input.availableToolNames.has(name));
  return { open: true, enable: [...available, 'navigate_view'], deny: [] };
}

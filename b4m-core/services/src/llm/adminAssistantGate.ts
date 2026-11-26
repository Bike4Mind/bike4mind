import {
  ADMIN_ASSISTANT_TOOL_NAMES,
  ADMIN_ASSISTANT_WITHHELD_TOOL_NAMES,
  isAdminAssistantGateOpen,
} from '@bike4mind/common';

export type AdminAssistantToolPlan = {
  open: boolean;
  enable: string[];
  deny: string[];
  disableUserIntegrations: boolean;
};

/**
 * Per-turn admin assistant tool plan. Open (admin surface + server-loaded isAdmin === true + the
 * acting user owns the session): offer the admin tools whose definitions the host supplied, plus
 * navigate_view for hand-offs to admin views, and withhold web and integration tools (MCP servers,
 * agents, the built-ins in ADMIN_ASSISTANT_WITHHELD_TOOL_NAMES) since admin tool results carry
 * customer-written text. Closed: deny every admin tool name so no other channel (request tools,
 * session.enabledTools, sticky auto-adds) can reach the model. Never persisted - see
 * adminAssistant.ts in @bike4mind/common.
 */
export function resolveAdminAssistantTools(input: {
  surface?: string | null;
  sessionOwnerId?: unknown;
  userId?: unknown;
  isAdmin?: boolean | null;
  availableToolNames: ReadonlySet<string>;
}): AdminAssistantToolPlan {
  const open = isAdminAssistantGateOpen(
    { surface: input.surface, userId: input.sessionOwnerId },
    { isAdmin: input.isAdmin, id: input.userId }
  );
  if (!open) {
    return { open: false, enable: [], deny: [...ADMIN_ASSISTANT_TOOL_NAMES], disableUserIntegrations: false };
  }
  const available = ADMIN_ASSISTANT_TOOL_NAMES.filter(name => input.availableToolNames.has(name));
  return {
    open: true,
    enable: [...available, 'navigate_view'],
    deny: [...ADMIN_ASSISTANT_WITHHELD_TOOL_NAMES],
    disableUserIntegrations: true,
  };
}

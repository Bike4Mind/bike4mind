import { ADMIN_ASSISTANT_TOOL_NAMES, B4MLLMToolsList, isAdminAssistantGateOpen } from '@bike4mind/common';

export type AdminAssistantToolPlan = {
  open: boolean;
  enable: string[];
  deny: string[];
  disableUserIntegrations: boolean;
};

/**
 * Per-turn admin assistant tool plan. Open (admin surface + server-loaded isAdmin === true + the
 * acting user owns the session): offer the admin tools whose definitions the host supplied, plus
 * navigate_view for hand-offs to admin views, and withhold everything else (every other built-in
 * tool, every non-admin key of availableToolNames whether contributed, client, slack or lattice,
 * MCP servers, agents) since admin tool results carry customer-written text. The built-in deny is
 * an allowlist, so a tool added to b4mLLMTools later is withheld by default. Closed: deny every
 * admin tool name so no other channel (request tools, session.enabledTools, sticky auto-adds) can
 * reach the model. Never persisted - see
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
  const adminToolNames: ReadonlySet<string> = new Set(ADMIN_ASSISTANT_TOOL_NAMES);
  const builtInToolNames: ReadonlySet<string> = new Set(B4MLLMToolsList);
  const available = ADMIN_ASSISTANT_TOOL_NAMES.filter(name => input.availableToolNames.has(name));
  return {
    open: true,
    enable: [...available, 'navigate_view'],
    deny: [
      ...B4MLLMToolsList.filter(name => name !== 'navigate_view'),
      ...[...input.availableToolNames].filter(
        name => name !== 'navigate_view' && !adminToolNames.has(name) && !builtInToolNames.has(name)
      ),
    ],
    disableUserIntegrations: true,
  };
}

/**
 * Contract for the admin assistant: the floating chat on the admin page gets
 * admin-only read tools. Deliberately NOT a registered workspace surface (see
 * surfaces.ts); the gate is evaluated fresh each turn from the session surface
 * and the server-loaded user, and these tool names are never persisted as sticky.
 */
export const ADMIN_ASSISTANT_SURFACE = 'admin-assistant' as const;

export const ADMIN_ASSISTANT_TOOL_NAMES = [
  'admin_get_user',
  'admin_get_user_credits',
  'admin_get_user_activity',
  'admin_get_user_feedback',
  'admin_get_usage_signals',
  'admin_get_org',
  'admin_get_org_usage',
  'admin_get_health',
  'admin_get_setting',
] as const;

export type AdminAssistantToolName = (typeof ADMIN_ASSISTANT_TOOL_NAMES)[number];

const ADMIN_ASSISTANT_TOOL_NAME_SET: ReadonlySet<string> = new Set(ADMIN_ASSISTANT_TOOL_NAMES);

export function isAdminAssistantToolName(name: string): name is AdminAssistantToolName {
  return ADMIN_ASSISTANT_TOOL_NAME_SET.has(name);
}

/** Open only for the exact surface id and a strictly-true `isAdmin`. */
export function isAdminAssistantGateOpen(
  session: { surface?: string | null },
  user: { isAdmin?: boolean | null }
): boolean {
  return session.surface === ADMIN_ASSISTANT_SURFACE && user.isAdmin === true;
}

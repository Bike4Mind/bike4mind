/**
 * Claude Code hook event name -> Hearth presence reason.
 *
 * This exists because the reason is DERIVABLE from the event name alone, and
 * that matters for privacy: the hook only forwards its `activity` block at
 * disclosure tier 2, so at tiers 0 and 1 the server has the event name and
 * nothing else. Deriving the reason here lets a minimum-disclosure session still
 * project a correct roster state - most importantly `session_end` ->
 * `disconnected`, which without this recorded every ended low-tier session as
 * permanently `running`.
 *
 * The hook (packages/cli/bin/hearth-hook.mjs) carries its own copy of this table
 * because it ships dependency-free under bare `node`, the same arrangement as
 * the slug in identity.ts. hookEvents.test.ts pins the two copies to each other.
 */

/**
 * Closed set, and closed on purpose: these values reach the roster's
 * REASON_STATES map, so an unrecognized event name must degrade to the generic
 * `active` rather than inventing a reason the projection cannot interpret.
 */
export const HOOK_EVENT_REASONS: Record<string, string> = {
  Stop: 'turn_finished',
  SubagentStop: 'turn_finished',
  PreToolUse: 'tool_use',
  PostToolUse: 'tool_use',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'prompt_submitted',
};

/** Fallback reason for an event name outside the table above. */
export const DEFAULT_HOOK_REASON = 'active';

export function reasonForHookEvent(eventName: string | null | undefined): string {
  if (!eventName) return DEFAULT_HOOK_REASON;
  // Own-property lookup: `constructor` and `__proto__` are legal strings on the
  // wire and must not read through Object.prototype.
  return Object.prototype.hasOwnProperty.call(HOOK_EVENT_REASONS, eventName)
    ? HOOK_EVENT_REASONS[eventName]
    : DEFAULT_HOOK_REASON;
}

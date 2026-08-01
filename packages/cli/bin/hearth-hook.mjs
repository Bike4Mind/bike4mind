#!/usr/bin/env node
// Claude Code hook: forwards hook events into the Hearth event log, so any
// Claude Code instance reports as a Hearth actor.
//
// Wire it in .claude/settings.json under hooks (Stop and/or Notification):
//   { "type": "command", "command": "node <path>/hearth-hook.mjs" }
// Requires: B4M_API_URL, B4M_API_KEY env vars.
// Optional: B4M_HEARTH_CHANNEL - a channel id. Unset, the hook addresses the
// shared default channel by NAME and the server find-or-creates it, so a fresh
// install needs no per-user setup and lands in the same channel the cc-bridge
// reports into (one roster, not two half-rosters).
// Always exits 0 - a reporting hook must never block the session.
//
// DISCLOSURE. Everything sent here lands in an append-only log that other
// actors read and that gateways may one day mirror to external parties, so the
// forwarded field set is an explicit tier rather than "whatever the hook
// happened to receive". B4M_HEARTH_DISCLOSURE selects it:
//   0 - event name, session id, session slug. Zero environment disclosure.
//   1 - adds the workspace BASENAME (the repo name, never a full path), except
//       when that basename would BE the OS username - the home directory is
//       omitted rather than sent, since `/Users/<user>` basenames to <user>.
//   2 - adds non-sensitive activity state: a reason code checked against the
//       known set, a tool name that is either a plain identifier or the bare
//       kind `mcp` (an mcp__<server>__<tool> name would otherwise disclose the
//       configured integration), permission mode, effort level, tool duration,
//       subagent type, and a background-task count. Default.
// Values are VALIDATED, not merely selected: a field documented as a closed set
// but forwarded unchecked is only a closed set until upstream adds a value.
// No tier forwards a field the hook docs mark as content-bearing: prompt,
// tool_input, tool_response, last_assistant_message, compact_summary,
// custom_instructions, transcript_path, the full cwd, or the raw notification
// message. The human-readable line is COMPOSED here from those safe parts
// rather than passing an upstream string through, because Notification.message
// may itself contain a path or a code snippet.
// __tests__/hearthHook.test.ts pins the exact field set of every tier, so a
// newly added field cannot silently escape its tier.
// Shipped standalone and run under bare `node`, so it stays dependency-free.

import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';

const { B4M_API_URL, B4M_API_KEY, B4M_HEARTH_CHANNEL, B4M_HEARTH_LABEL, B4M_HEARTH_DISCLOSURE } = process.env;

const DEFAULT_DISCLOSURE = 2;
const MAX_DISCLOSURE = 2;
/**
 * Where an UNPARSEABLE value lands. Deliberately the minimum, not the default:
 * `none`, `off`, `min`, `zero`, a quoted `"0"`, or an unexpanded `$LEVEL` all
 * parse to NaN, and an operator who typed any of those was reaching for LESS
 * disclosure, not more. Resolving NaN to the default (which is also the
 * maximum) meant every one of those silently produced the widest tier, and
 * because unset and set-but-garbage were indistinguishable the misconfiguration
 * was undetectable from the outside. A privacy control has to fail closed.
 */
const MALFORMED_DISCLOSURE = 0;

/** Must match DEFAULT_HEARTH_CHANNEL_NAME in b4m-core/hearth; the hook is
 *  dependency-free and cannot import it. */
const DEFAULT_CHANNEL_NAME = 'agents';

/**
 * UNSET means the default tier. SET-BUT-UNPARSEABLE means the minimum, because
 * a garbage value is a misconfiguration and the safe reading of a broken
 * privacy setting is the narrow one. Out-of-range values clamp into range.
 */
function disclosureTier() {
  if (B4M_HEARTH_DISCLOSURE === undefined || B4M_HEARTH_DISCLOSURE === '') return DEFAULT_DISCLOSURE;
  const parsed = Number.parseInt(B4M_HEARTH_DISCLOSURE, 10);
  if (Number.isNaN(parsed)) return MALFORMED_DISCLOSURE;
  return Math.max(0, Math.min(MAX_DISCLOSURE, parsed));
}

// 32x32 = 1024 pairs. Collisions are cosmetic (the exact session_id still
// travels in the payload); the point is that a human can tell two live sessions
// apart at a glance, which a uuid prefix does not achieve.
const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'clever', 'copper', 'crimson', 'dapper', 'eager',
  'fluent', 'gentle', 'golden', 'hardy', 'humble', 'ivory', 'jolly', 'keen',
  'lucid', 'merry', 'nimble', 'noble', 'olive', 'patient', 'quiet', 'rapid',
  'rustic', 'silver', 'solemn', 'sunny', 'teal', 'tidy', 'vivid', 'wry',
];
const ANIMALS = [
  'otter', 'heron', 'lynx', 'marten', 'badger', 'falcon', 'ibex', 'jackal',
  'kestrel', 'lemur', 'magpie', 'newt', 'osprey', 'puffin', 'quail', 'raven',
  'shrike', 'tapir', 'urchin', 'viper', 'walrus', 'yak', 'zebra', 'bison',
  'crane', 'dingo', 'egret', 'ferret', 'gecko', 'hare', 'impala', 'jay',
];

/** djb2. Deterministic across processes and restarts, which is the whole point. */
function hashOf(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * A readable, stable name for a session, derived purely from an id the hook
 * already sends - so it costs no additional disclosure.
 */
function sessionSlug(sessionId) {
  if (!sessionId) return 'unknown-session';
  const hash = hashOf(sessionId);
  const animalIndex = Math.floor(hash / ADJECTIVES.length) % ANIMALS.length;
  return `${ADJECTIVES[hash % ADJECTIVES.length]}-${ANIMALS[animalIndex]}`;
}

/** Reason codes for events that are not Notifications. Closed set. */
function reasonForEvent(eventName) {
  switch (eventName) {
    case 'Stop':
    case 'SubagentStop':
      return 'turn_finished';
    case 'PreToolUse':
    case 'PostToolUse':
      return 'tool_use';
    case 'SessionStart':
      return 'session_start';
    case 'SessionEnd':
      return 'session_end';
    case 'UserPromptSubmit':
      return 'prompt_submitted';
    default:
      return 'active';
  }
}

/**
 * Non-sensitive activity state. Every field here is a closed-set string or a
 * number: notification_type is the documented machine-readable classifier (so
 * the raw message never needs to be forwarded OR parsed), and permission_mode,
 * effort level, and duration are the concrete "capability + cost + latency"
 * a presence roster wants. background_tasks is reduced to a COUNT because the
 * task descriptions and commands inside it are content-bearing.
 */
function activityOf(hook) {
  // notification_type is forwarded ONLY if it is a reason we actually know.
  // REASON_PHRASES already enumerates that vocabulary, so an unknown value falls
  // back to the event-derived code instead of passing an upstream string through.
  const notified =
    typeof hook.notification_type === 'string' && Object.hasOwn(REASON_PHRASES, hook.notification_type)
      ? hook.notification_type
      : undefined;
  const activity = { reason: notified ?? reasonForEvent(hook.hook_event_name) };
  const tool = toolOf(hook.tool_name);
  if (tool) activity.tool = tool;
  if (typeof hook.permission_mode === 'string' && hook.permission_mode) {
    activity.permission_mode = hook.permission_mode;
  }
  if (typeof hook.effort?.level === 'string' && hook.effort.level) activity.effort = hook.effort.level;
  if (typeof hook.duration_ms === 'number') activity.duration_ms = hook.duration_ms;
  if (typeof hook.agent_type === 'string' && hook.agent_type) activity.subagent = hook.agent_type;
  if (Array.isArray(hook.background_tasks)) activity.background_tasks = hook.background_tasks.length;
  return activity;
}

/**
 * Workspace name for tier >= 1: the basename of the session's directory, or
 * undefined when there is no name safe to send.
 *
 * The HOME directory is excluded because its basename IS the OS username on
 * macOS and Linux (`/Users/<user>`, `/home/<user>`) - and starting a session in
 * the home directory is ordinary, so this fired on real sessions at the default
 * tier while the file header promised "the repo name, never a full path". A
 * filesystem root has no useful name either.
 *
 * What this does NOT try to solve: any basename is still a directory name the
 * user chose, so a directory named after a client or a project discloses that
 * name. That is the acknowledged cost of tier 1 and the reason tier 0 exists.
 */
function workspaceOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return undefined;
  const absolute = resolve(cwd);
  let home;
  try {
    home = homedir();
  } catch {
    home = undefined;
  }
  if (home && absolute === resolve(home)) return undefined;
  const name = basename(absolute);
  // basename('/') is '' and basename('/root') is a system account, not a workspace.
  if (!name || name === 'root') return undefined;
  return name;
}

/**
 * Tool names that may be forwarded verbatim vs. reduced.
 *
 * An MCP tool is named `mcp__<server>__<tool>`, so forwarding it verbatim
 * disclosed every configured MCP SERVER name at the default tier - the field was
 * documented as a closed set but was `hook.tool_name` unchecked. Reducing it to
 * a bare `mcp` keeps the signal a roster actually wants ("it is calling out to a
 * tool") without naming the integration. Anything else unrecognized is dropped
 * rather than guessed at, since a built-in tool name is a short identifier and a
 * value that is not one did not come from the closed set.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function toolOf(toolName) {
  if (typeof toolName !== 'string' || !toolName) return undefined;
  if (toolName.startsWith('mcp__')) return 'mcp';
  return TOOL_NAME_PATTERN.test(toolName) ? toolName : undefined;
}

/** Phrases for the closed reason set. Anything unrecognized degrades to a
 *  generic line rather than echoing an upstream string. */
const REASON_PHRASES = {
  permission_prompt: 'needs permission',
  idle_prompt: 'is waiting for input',
  agent_needs_input: 'is waiting for input',
  agent_completed: 'finished',
  auth_success: 'authenticated',
  elicitation_dialog: 'is asking a question',
  elicitation_complete: 'got its answer',
  elicitation_response: 'got its answer',
  turn_finished: 'finished a turn',
  tool_use: 'is running a tool',
  session_start: 'started a session',
  session_end: 'ended a session',
  prompt_submitted: 'received a prompt',
  active: 'is active',
};

/** Human-readable one-liner composed from known-safe parts only. */
function describe({ label, tier, workspace, activity }) {
  const where = tier >= 1 && workspace ? ` in ${workspace}` : '';
  if (tier < 2) return `${label}${where} reported in`;
  const phrase = REASON_PHRASES[activity.reason] ?? 'is active';
  const tool = activity.reason === 'permission_prompt' && activity.tool ? `: ${activity.tool}` : '';
  return `${label}${where} ${phrase}${tool}`;
}

const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    if (!B4M_API_URL || !B4M_API_KEY) return;
    const hook = JSON.parse(Buffer.concat(chunks).toString() || '{}');

    const tier = disclosureTier();
    const eventName = hook.hook_event_name ?? 'unknown';
    const sessionId = hook.session_id ?? null;
    const slug = sessionSlug(sessionId);
    // One actor per session. That is what makes presence rows distinguishable,
    // gives each reader an independent cursor, and yields a stable per-session
    // color downstream - all three followed from the single collapsed actor.
    const label = B4M_HEARTH_LABEL || `Claude Code (${slug})`;

    const payload = { hook_event_name: eventName, session_id: sessionId, slug };
    const workspace = workspaceOf(hook.cwd);
    if (tier >= 1 && workspace) payload.workspace = workspace;
    const activity = activityOf(hook);
    if (tier >= 2) payload.activity = activity;

    await fetch(new URL('/api/hearth/events', B4M_API_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': B4M_API_KEY },
      body: JSON.stringify({
        ...(B4M_HEARTH_CHANNEL ? { channelId: B4M_HEARTH_CHANNEL } : { channelName: DEFAULT_CHANNEL_NAME }),
        kind: 'presence',
        human: { text: describe({ label, tier, workspace, activity }), format: 'text' },
        machine: { schema: 'hearth.claude-code-hook@1', payload },
        refs: {},
        // Self-identify as an agent actor. Without this the hook resolved to the
        // account's HUMAN actor, so every heartbeat rendered as if the person
        // had posted it - the log could not distinguish operator from tooling.
        actor: { kind: 'agent', displayName: label },
      }),
      // Bounded so a hung request can never stall the session past 3s.
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Swallow everything: reporting must never fail the hook.
  } finally {
    process.exit(0);
  }
});

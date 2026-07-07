/**
 * Pure mapping layer between the B4M agent core and the Agent Client Protocol
 * (ACP) wire types. Everything here is side-effect free so it can be unit
 * tested without a live connection - the stateful server (AcpServer) composes
 * these helpers.
 *
 * ACP spec: https://agentclientprotocol.com
 */

import { PROTOCOL_VERSION, type schema } from './acpSdk.js';
import type { AgentStep } from '@bike4mind/agents';
import type { PermissionResponse } from '../components';
import type { InteractionMode } from '../bootstrap/types.js';

/** Protocol version this agent implements (re-exported for the server). */
export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** Identifies this agent to ACP clients (shown in the editor's agent panel). */
export const AGENT_INFO = {
  name: 'bike4mind',
  title: 'Bike4Mind',
} as const;

// ---------------------------------------------------------------------------
// Session modes
//
// The CLI's own interaction modes are 'normal' | 'auto-accept' | 'plan'.
// 'auto-accept' is a NO-PROMPT mode: gated tools run without asking. Exposing
// it over ACP would let an editor client silently bypass the permission
// round-trip, which the issue forbids ("unsafe/no-prompt modes are not
// selectable over the wire"). So we deliberately advertise only the two modes
// that always route permission decisions back to the client:
//   - 'ask'  -> CLI 'normal' (every gated tool triggers session/request_permission)
//   - 'plan' -> CLI 'plan'   (read/plan oriented; still prompts on gated tools)
// Any other mode id is rejected in session/set_mode.
// ---------------------------------------------------------------------------

export const ACP_MODE_ASK = 'ask';
export const ACP_MODE_PLAN = 'plan';
export const DEFAULT_ACP_MODE = ACP_MODE_ASK;

/** ACP mode ids that a client is permitted to select. Order = display order. */
export const SAFE_ACP_MODES: schema.SessionMode[] = [
  {
    id: ACP_MODE_ASK,
    name: 'Ask',
    description: 'Prompts for permission before every gated tool call.',
  },
  {
    id: ACP_MODE_PLAN,
    name: 'Plan',
    description: 'Planning-oriented; still prompts for permission on gated tools.',
  },
];

/** The mode state advertised on session/new and session/load. */
export function buildSessionModeState(currentModeId: string = DEFAULT_ACP_MODE): schema.SessionModeState {
  return { currentModeId, availableModes: SAFE_ACP_MODES };
}

/**
 * Map a client-selected ACP mode id to a CLI interaction mode. Returns null for
 * any id outside the safe allowlist so the caller can reject it (fail closed) -
 * this is what keeps the unsafe 'auto-accept' no-prompt mode off the wire.
 */
export function acpModeToInteraction(modeId: string): InteractionMode | null {
  switch (modeId) {
    case ACP_MODE_ASK:
      return 'normal';
    case ACP_MODE_PLAN:
      return 'plan';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Tool-call presentation
// ---------------------------------------------------------------------------

/**
 * Classify a B4M tool into an ACP ToolKind so the editor can pick an icon and
 * UI treatment. Driven by tool-name heuristics (mutation verbs win over read
 * verbs); an unclassifiable tool maps to 'other' rather than being assumed
 * read-only.
 */
export function toolKind(toolName: string): schema.ToolKind {
  const name = toolName.toLowerCase();
  if (/delete|remove|(^|_)rm(_|$)/.test(name)) return 'delete';
  if (/move|rename|(^|_)mv(_|$)/.test(name)) return 'move';
  if (/write|edit|patch|apply|create|update|append/.test(name)) return 'edit';
  if (/exec|run|shell|bash|command|terminal/.test(name)) return 'execute';
  if (/search|grep|find|glob|list/.test(name)) return 'search';
  if (/fetch|web|http|url|download|crawl/.test(name)) return 'fetch';
  if (/read|cat|view|show|open|get_file|structure|definition/.test(name)) return 'read';
  return 'other';
}

/** Compact a tool's input into a one-line human-readable title. */
export function toolCallTitle(toolName: string, toolInput: unknown): string {
  const summary = summarizeInput(toolInput);
  return summary ? `${toolName}(${summary})` : toolName;
}

function summarizeInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return truncate(input, 80);
  try {
    return truncate(JSON.stringify(input), 80);
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Permission bridging
//
// The CLI permission callback resolves to one of four PermissionResponse
// actions. We surface three of them as ACP permission options (there is no ACP
// option kind for session-scoped trust, so we offer once / always / reject and
// treat everything else as a denial). optionId round-trips the CLI action.
// ---------------------------------------------------------------------------

export const PERMISSION_OPTION_ALLOW_ONCE = 'allow-once';
export const PERMISSION_OPTION_ALLOW_ALWAYS = 'allow-always';
export const PERMISSION_OPTION_REJECT = 'deny';

export function buildPermissionOptions(): schema.PermissionOption[] {
  return [
    { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
    { optionId: PERMISSION_OPTION_ALLOW_ALWAYS, name: 'Always allow', kind: 'allow_always' },
    { optionId: PERMISSION_OPTION_REJECT, name: 'Reject', kind: 'reject_once' },
  ];
}

/**
 * Resolve an ACP permission outcome to a CLI PermissionResponse. Fails CLOSED:
 * a cancelled turn, an unknown option id, or a missing outcome all deny.
 */
export function permissionResponseFromOutcome(
  outcome: schema.RequestPermissionOutcome | null | undefined
): PermissionResponse {
  if (!outcome || outcome.outcome !== 'selected') return 'deny';
  switch (outcome.optionId) {
    case PERMISSION_OPTION_ALLOW_ONCE:
      return 'allow-once';
    case PERMISSION_OPTION_ALLOW_ALWAYS:
      return 'allow-always';
    case PERMISSION_OPTION_REJECT:
      return 'deny';
    default:
      return 'deny';
  }
}

// ---------------------------------------------------------------------------
// Prompt input
// ---------------------------------------------------------------------------

/**
 * Flatten a prompt's content blocks into a single text string for the agent.
 * Text blocks pass through; resource links are rendered as an @-reference so
 * the agent's file tools can pick them up. Image/audio/embedded blocks are
 * summarized as a placeholder (v1 sends text to the agent core).
 */
export function contentBlocksToText(blocks: schema.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'resource_link':
        parts.push(`@${block.uri}`);
        break;
      case 'resource':
        if (
          'resource' in block &&
          block.resource &&
          'text' in block.resource &&
          typeof block.resource.text === 'string'
        ) {
          parts.push(block.resource.text);
        } else if ('resource' in block && block.resource && 'uri' in block.resource) {
          parts.push(`@${block.resource.uri}`);
        }
        break;
      case 'image':
        parts.push('[image]');
        break;
      case 'audio':
        parts.push('[audio]');
        break;
      default:
        break;
    }
  }
  return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Agent event -> session/update mapping
// ---------------------------------------------------------------------------

function textChunk(text: string): schema.ContentBlock {
  return { type: 'text', text };
}

export function agentMessageChunk(text: string): schema.SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: textChunk(text) };
}

export function agentThoughtChunk(text: string): schema.SessionUpdate {
  return { sessionUpdate: 'agent_thought_chunk', content: textChunk(text) };
}

export function userMessageChunk(text: string): schema.SessionUpdate {
  return { sessionUpdate: 'user_message_chunk', content: textChunk(text) };
}

/** A tool call entering the in-progress state (emitted on an `action` step). */
export function toolCallStart(toolCallId: string, step: AgentStep): schema.SessionUpdate {
  const toolName = step.metadata?.toolName ?? 'tool';
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: toolCallTitle(toolName, step.metadata?.toolInput),
    kind: toolKind(toolName),
    status: 'in_progress',
    rawInput: step.metadata?.toolInput ?? undefined,
  };
}

/** A tool call reaching a terminal state (emitted on an `observation` step). */
export function toolCallCompleted(toolCallId: string, content: string): schema.SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: content ? [{ type: 'content', content: textChunk(content) }] : undefined,
  };
}

/** Notify the client of the current mode after a session/set_mode. */
export function currentModeUpdate(currentModeId: string): schema.SessionUpdate {
  return { sessionUpdate: 'current_mode_update', currentModeId };
}

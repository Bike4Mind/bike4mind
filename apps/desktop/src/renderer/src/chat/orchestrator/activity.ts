import { snippetOf } from '@shared/agentOutcome';
import type { ChatStreamEvent, ChatToolCall } from '@shared/chat';
import type { AgentView } from './roster';

/** What a running agent is doing right now, as far as its stream shows. Status only, never stored. */
export type AgentActivity =
  | { kind: 'tool'; tool: string; detail: string }
  | { kind: 'phase'; phase: 'waiting' | 'thinking' | 'responding' | 'writing-tool'; tool?: string };

const DETAIL_MAX = 60;
const DETAIL_KEYS = ['path', 'file_path', 'command', 'pattern', 'query', 'url'] as const;
const PATH_KEYS: ReadonlySet<string> = new Set(['path', 'file_path']);

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function describeToolInput(call: Pick<ChatToolCall, 'name' | 'input'>): string {
  for (const key of DETAIL_KEYS) {
    const value = call.input[key];
    if (typeof value !== 'string' || value === '') continue;
    return snippetOf(PATH_KEYS.has(key) ? basename(value) : value, DETAIL_MAX);
  }
  return '';
}

function sameActivity(a: AgentActivity, b: AgentActivity): boolean {
  if (a.kind === 'tool' && b.kind === 'tool') return a.tool === b.tool && a.detail === b.detail;
  if (a.kind === 'phase' && b.kind === 'phase') return a.phase === b.phase && a.tool === b.tool;
  return false;
}

function activityFor(event: ChatStreamEvent): AgentActivity | null | undefined {
  switch (event.type) {
    case 'tool-start':
      return { kind: 'tool', tool: event.call.name, detail: describeToolInput(event.call) };
    case 'tool-end':
      return { kind: 'phase', phase: 'waiting' };
    case 'phase':
      return event.phase.kind === 'writing-tool'
        ? { kind: 'phase', phase: 'writing-tool', tool: event.phase.name }
        : { kind: 'phase', phase: event.phase.kind };
    case 'done':
    case 'error':
      return null;
    default:
      return undefined;
  }
}

/**
 * Folds one stream event into the per-session activity map. Returns `current` itself whenever
 * nothing changes, so a React state setter fed this does not re-render on every delta.
 */
export function foldActivity(
  current: ReadonlyMap<string, AgentActivity>,
  event: ChatStreamEvent
): ReadonlyMap<string, AgentActivity> {
  const next = activityFor(event);
  if (next === undefined) return current;

  const existing = current.get(event.sessionId);
  if (next === null) {
    if (!existing) return current;
    const without = new Map(current);
    without.delete(event.sessionId);
    return without;
  }
  if (existing && sameActivity(existing, next)) return current;
  return new Map(current).set(event.sessionId, next);
}

export type ToolKind = 'edit' | 'read' | 'shell' | 'web' | 'agent' | 'other';

// Order matters: 'bash_list' is a shell tool, not a read, and 'session_read' is an agent tool.
const KIND_RULES: ReadonlyArray<readonly [ToolKind, RegExp]> = [
  ['agent', /session_/],
  ['edit', /write|edit|patch/],
  ['shell', /bash|shell|exec|command|process|terminal/],
  ['web', /web|browser|fetch|http/],
  ['read', /read|grep|glob|search|list|find/],
];

export function toolKind(name: string): ToolKind {
  const lowered = name.toLowerCase();
  return KIND_RULES.find(([, pattern]) => pattern.test(lowered))?.[0] ?? 'other';
}

const PHASE_LABEL = {
  waiting: 'Waiting on the model',
  thinking: 'Thinking',
  responding: 'Writing a reply',
} as const;

export function activityLabel(activity: AgentActivity): string {
  if (activity.kind === 'tool') return `${activity.tool} ${activity.detail}`.trim();
  if (activity.phase === 'writing-tool') return `Preparing ${activity.tool ?? 'a tool'}`;
  return PHASE_LABEL[activity.phase];
}

/** The "Now" text shared by the table and board: live activity while working, else the last snippet. */
export function agentNowText(agent: Pick<AgentView, 'state' | 'activity' | 'lastSnippet'>): string | undefined {
  if (agent.state === 'working' && agent.activity) return activityLabel(agent.activity);
  return agent.lastSnippet || undefined;
}

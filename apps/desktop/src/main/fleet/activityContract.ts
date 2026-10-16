/**
 * The Fleet activity wire contract, mirrored so a batch is checked here before it is sent.
 *
 * Must stay in sync with Fleet's `POST /api/integrations/bike4mind/v1/activity` validator: a
 * batch Fleet would reject is a batch this side would otherwise retry forever.
 */

export const ACTIVITY_VERSION = 1;
export const MAX_BATCH_EVENTS = 24;
export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/** Fleet refuses anything older than 31 days; a day of margin covers clock skew and a slow flush. */
export const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const REPO_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const TOOL_CATEGORIES = ['shell', 'editor', 'browser', 'mcp', 'agent', 'other'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];
export const REPOSITORY_ACTIONS = ['view', 'edit', 'commit', 'review'] as const;
export type RepositoryAction = (typeof REPOSITORY_ACTIONS)[number];

interface BaseEvent {
  eventId: string;
  occurredAt: string;
  durationMs: number;
  sessionId: string;
}

export type ActivityEvent =
  | (BaseEvent & { type: 'session' })
  | (BaseEvent & { type: 'repository'; repository: { owner: string; name: string; action: RepositoryAction } })
  | (BaseEvent & { type: 'tool'; tool: { type: ToolCategory } });

export interface ActivityBatch {
  version: 1;
  consent: true;
  events: ActivityEvent[];
}

export const isActivityId = (value: string): boolean => ID_RE.test(value);
export const isRepositoryPart = (value: string): boolean => REPO_PART_RE.test(value);

/** Whether Fleet would accept this event right now. Pure. */
export function isValidEvent(event: ActivityEvent, nowMs: number): boolean {
  if (!isActivityId(event.eventId) || !isActivityId(event.sessionId)) return false;
  const at = Date.parse(event.occurredAt);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== event.occurredAt) return false;
  if (at < nowMs - MAX_EVENT_AGE_MS || at > nowMs + MAX_FUTURE_MS) return false;
  if (!Number.isInteger(event.durationMs) || event.durationMs < 0 || event.durationMs > MAX_DURATION_MS) return false;
  if (event.type === 'repository') {
    const { owner, name, action } = event.repository;
    return isRepositoryPart(owner) && isRepositoryPart(name) && REPOSITORY_ACTIONS.includes(action);
  }
  if (event.type === 'tool') return TOOL_CATEGORIES.includes(event.tool.type);
  return event.type === 'session';
}

/** A duration clamped into what Fleet accepts. */
export function clampDuration(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms), MAX_DURATION_MS);
}

/** The next batch to send: up to 24 events, unique ids, under the byte cap. Pure. */
export function nextBatch(events: readonly ActivityEvent[]): ActivityBatch | null {
  const picked: ActivityEvent[] = [];
  const ids = new Set<string>();
  for (const event of events) {
    if (picked.length >= MAX_BATCH_EVENTS) break;
    if (ids.has(event.eventId)) continue;
    const candidate = [...picked, event];
    if (new TextEncoder().encode(JSON.stringify(batchOf(candidate))).byteLength > MAX_BATCH_BYTES) break;
    picked.push(event);
    ids.add(event.eventId);
  }
  return picked.length > 0 ? batchOf(picked) : null;
}

function batchOf(events: ActivityEvent[]): ActivityBatch {
  return { version: ACTIVITY_VERSION, consent: true, events };
}

/**
 * Which Fleet tool category a chat tool falls in. Only the category leaves this machine, never
 * the tool's name or arguments.
 */
export function toolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__') || name.startsWith('mcp_')) return 'mcp';
  if (name.startsWith('bash_') || name === 'terminal') return 'shell';
  if (name.startsWith('browser_') || name.startsWith('web_')) return 'browser';
  if (
    ['file_read', 'file_write', 'file_edit', 'apply_patch', 'glob_files', 'grep_search', 'request_directory'].includes(
      name
    )
  ) {
    return 'editor';
  }
  if (name.startsWith('session_') || name === 'explore') return 'agent';
  return 'other';
}

/** Tools whose success means the turn changed files in the working tree. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['file_write', 'file_edit', 'apply_patch']);

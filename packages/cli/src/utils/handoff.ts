import { promises as fs } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  Message,
  Session,
  SessionHandoff,
  WorkflowBlocker,
  WorkflowDecision,
  WorkflowState,
} from '../storage/types.js';
import type { TodoItem } from '../tools/writeTodosTool.js';
import { COMPACTION_SUMMARY_MARKER } from '../config/constants.js';

/**
 * Sessions with fewer messages than this skip handoff generation.
 * Short sessions don't have enough context to produce a meaningful handoff.
 */
export const SHORT_SESSION_THRESHOLD = 4;

/**
 * Prefix tag used to mark a system message as an injected handoff. Kept as a
 * single source of truth so the dedup-on-resume check and the system-message
 * builder cannot drift out of sync.
 */
export const HANDOFF_MARKER = '[Session handoff from previous session]';

export const MAX_MESSAGE_CHARS = 2000;
/**
 * The handoff prompt includes both ends of the conversation: the first
 * HEAD messages (original goal framing / foundational decisions) and the last
 * TAIL messages (current state). On sessions longer than HEAD + TAIL the middle
 * is elided, so prompt size stays bounded regardless of session length while
 * neither end of the conversation is lost. Decisions and blockers from workflow
 * state are still included in full above the excerpt.
 *
 * When a compaction summary sits before the tail window it is pinned as the head
 * instead of the raw first messages - it already distills everything before it.
 */
export const HEAD_CONVERSATION_MESSAGES = 15;
export const TAIL_CONVERSATION_MESSAGES = 50;
const ROLE_LABELS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
};

/**
 * Build a prompt instructing the LLM to produce a structured session handoff
 * as JSON. Incorporates decisions and blockers from the existing workflow state
 * so the handoff reflects durable state, not just chat history.
 *
 * Any previously-injected handoff message (from a prior /resume) is filtered
 * out - the LLM should produce a fresh handoff from the actual conversation,
 * not echo back a prior handoff sitting at the top of the message list.
 *
 * Returns an empty string for short sessions - callers should skip generation.
 */
export function buildHandoffPrompt(session: Session): string {
  if (session.messages.length < SHORT_SESSION_THRESHOLD) {
    return '';
  }

  const filtered = session.messages.filter(m => !isInjectedHandoff(m));
  const { head, tail, elidedCount } = selectHandoffExcerpt(filtered);

  let prompt = `You are generating a structured session handoff so the next session (or another agent) can pick up seamlessly without re-reading the full chat history.

Output a single JSON object — no prose, no markdown fences — with exactly these fields:

{
  "summary": "2-4 sentence overview of what this session accomplished and where it ended",
  "keyFindings": ["concise factual discoveries — e.g. 'auth bug is in middleware.ts:42, caused by missing token refresh'"],
  "nextSteps": ["concrete actions the next session should take, in priority order"],
  "pendingDecisions": ["open questions or trade-offs awaiting a decision"],
  "blockers": ["anything preventing progress — wait conditions, missing inputs, broken upstream"]
}

Rules:
- Each list item is a single line, no nested structure.
- Empty lists are fine — use [] when nothing applies.
- Be specific: cite filenames, function names, error messages where relevant.
- Do not invent context. Only include items grounded in the conversation or workflow state below.

`;

  prompt += appendWorkflowContext(session.metadata.workflow);
  prompt += `CONVERSATION:\n\n`;

  for (const msg of head) {
    prompt += renderExcerptMessage(msg);
  }
  if (elidedCount > 0) {
    prompt += `_[${elidedCount} earlier messages omitted]_\n\n`;
  }
  for (const msg of tail) {
    prompt += renderExcerptMessage(msg);
  }

  prompt += `\nReturn only the JSON object.`;

  return prompt;
}

function renderExcerptMessage(msg: Message): string {
  const role = ROLE_LABELS[msg.role] || 'System';
  const content =
    msg.content.length > MAX_MESSAGE_CHARS ? msg.content.slice(0, MAX_MESSAGE_CHARS) + '...[truncated]' : msg.content;
  return `**${role}:** ${content}\n\n`;
}

/**
 * Select the conversation excerpt for the handoff prompt: a head block plus the
 * TAIL most recent messages, with the middle elided so prompt size stays bounded
 * regardless of session length. `filtered` must already have prior handoffs
 * stripped; message order is chronological (index 0 = oldest).
 *
 * When the whole conversation fits within HEAD + TAIL, everything is returned as
 * the head with no tail and no elision (behavior matches the pre-window code).
 * Otherwise the head is either the most recent compaction summary that lies
 * before the tail window (it already distills everything before it), or - when
 * no such summary exists - the first HEAD raw messages (original goal framing).
 * If a summary exists only inside the tail window it is already shown, so no
 * head is emitted. Head is always strictly before the tail window, so head and
 * tail never overlap.
 */
function selectHandoffExcerpt(filtered: Message[]): {
  head: Message[];
  tail: Message[];
  elidedCount: number;
} {
  const n = filtered.length;
  if (n <= HEAD_CONVERSATION_MESSAGES + TAIL_CONVERSATION_MESSAGES) {
    return { head: filtered, tail: [], elidedCount: 0 };
  }

  const tailStart = n - TAIL_CONVERSATION_MESSAGES;
  const tail = filtered.slice(tailStart);

  let summaryIdx = -1;
  for (let i = tailStart - 1; i >= 0; i--) {
    if (filtered[i].content.startsWith(COMPACTION_SUMMARY_MARKER)) {
      summaryIdx = i;
      break;
    }
  }

  let head: Message[];
  let headEndExclusive: number;
  if (summaryIdx !== -1) {
    head = [filtered[summaryIdx]];
    headEndExclusive = summaryIdx + 1;
  } else if (tail.some(m => m.content.startsWith(COMPACTION_SUMMARY_MARKER))) {
    // A summary exists only inside the tail window - already shown, so no head.
    // The backward loop above already proved [0, tailStart) has no marker, so
    // scanning only the tail is equivalent and states the intent directly.
    head = [];
    headEndExclusive = 0;
  } else {
    head = filtered.slice(0, HEAD_CONVERSATION_MESSAGES);
    headEndExclusive = HEAD_CONVERSATION_MESSAGES;
  }

  return { head, tail, elidedCount: tailStart - headEndExclusive };
}

function appendWorkflowContext(workflow: WorkflowState | undefined): string {
  if (!workflow) return '';

  const sections: string[] = [];

  if (workflow.decisions.length > 0) {
    const lines = workflow.decisions.map(d => `- ${d.summary} (rationale: ${d.rationale})`);
    sections.push(`LOGGED DECISIONS:\n${lines.join('\n')}`);
  }

  const openBlockers = workflow.blockers.filter(b => b.status === 'open');
  if (openBlockers.length > 0) {
    const lines = openBlockers.map(b => `- ${b.description}`);
    sections.push(`OPEN BLOCKERS:\n${lines.join('\n')}`);
  }

  return sections.length > 0 ? `${sections.join('\n\n')}\n\n` : '';
}

/**
 * Parse a raw LLM response into a SessionHandoff.
 *
 * Tolerates fenced code blocks (```json ... ```) and surrounding prose by
 * extracting the first balanced JSON object. Returns null if no valid handoff
 * can be parsed - callers decide how to surface that to the user.
 */
export function parseHandoffResponse(response: string): SessionHandoff | null {
  const json = extractJsonObject(response);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!summary) return null;

  return {
    summary,
    keyFindings: toStringArray(obj.keyFindings),
    nextSteps: toStringArray(obj.nextSteps),
    pendingDecisions: toStringArray(obj.pendingDecisions),
    blockers: toStringArray(obj.blockers),
    generatedAt: new Date().toISOString(),
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  const start = candidate.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Render a SessionHandoff for terminal display, including the generation
 * timestamp so the user knows how fresh the context is.
 */
export function formatHandoffOutput(handoff: SessionHandoff): string {
  return formatHandoff(handoff, { includeTimestamp: true });
}

/**
 * Build the system message that injects handoff context into a resumed
 * session. Excludes the timestamp so the message text is stable across
 * regenerations - important for keeping LLM prompt caches warm.
 */
export function buildHandoffSystemMessage(handoff: SessionHandoff): string {
  return `${HANDOFF_MARKER}\n\n${formatHandoff(handoff, { includeTimestamp: false })}`;
}

function formatHandoff(handoff: SessionHandoff, options: { includeTimestamp: boolean }): string {
  const lines: string[] = [handoff.summary, ''];

  appendSection(lines, 'Key findings', handoff.keyFindings);
  appendSection(lines, 'Next steps', handoff.nextSteps);
  appendSection(lines, 'Pending decisions', handoff.pendingDecisions);
  appendSection(lines, 'Blockers', handoff.blockers);

  if (options.includeTimestamp) {
    lines.push(`Generated: ${handoff.generatedAt}`);
  } else if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

function appendSection(lines: string[], heading: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`${heading}:`);
  for (const item of items) {
    lines.push(`  - ${item}`);
  }
  lines.push('');
}

/**
 * True when a message is a previously-injected handoff message.
 * Used to deduplicate handoff injections across save/resume cycles.
 *
 * Stored as `user` (not `system`) so it survives the user/assistant filter
 * applied to `previousMessages` before each agent.run() call - otherwise the
 * handoff would be persisted but never reach the LLM.
 */
export function isInjectedHandoff(message: Message): boolean {
  return message.role === 'user' && message.content.startsWith(HANDOFF_MARKER);
}

/**
 * Return a new message list with the handoff prepended as a user message.
 * Any previously-injected handoff anywhere in the list is removed so the
 * message list stays stable across repeated save/resume cycles. We scan the
 * whole list rather than just index 0 because compaction can prepend a
 * summary message, pushing the prior handoff to a later index.
 */
export function injectHandoffMessage(messages: Message[], handoff: SessionHandoff): Message[] {
  const handoffMessage: Message = {
    id: uuidv4(),
    role: 'user',
    content: buildHandoffSystemMessage(handoff),
    timestamp: new Date().toISOString(),
  };

  const withoutPriorHandoffs = messages.filter(m => !isInjectedHandoff(m));
  return [handoffMessage, ...withoutPriorHandoffs];
}

/**
 * Number of recent conversation messages included verbatim in the local
 * (LLM-free) handoff markdown. Most recent are kept since they best reflect
 * where the session ended.
 */
export const LOCAL_HANDOFF_MESSAGE_TAIL = 20;
const LOCAL_HANDOFF_MESSAGE_CHARS = 1500;

/**
 * Build a SessionHandoff purely from local session state, without any LLM
 * call. The fields are populated directly from workflow state - no synthesis,
 * no narrative summary. This is the structural fallback when the LLM is
 * unreachable (rate-limit, network, auth, upstream outage).
 *
 * The shape matches the LLM-generated handoff so callers can persist it in
 * `session.metadata.workflow.handoff` interchangeably.
 *
 * `workflowOverride` lets callers pass the authoritative decision/blocker
 * arrays (typically from in-memory ref stores) when `session.metadata.workflow`
 * may not yet have been synced from those refs. Without it, the handoff would
 * reflect a stale snapshot while `applyHandoffToWorkflow` writes the fresh
 * refs - leaving the handoff and the surrounding workflow object out of sync.
 * The optional `todos` carries the live in-memory todo list (never persisted to
 * the session), so the fallback can surface open work as next steps.
 */
export function buildLocalHandoff(
  session: Session,
  workflowOverride?: {
    decisions: WorkflowDecision[];
    blockers: WorkflowBlocker[];
    todos?: TodoItem[];
  }
): SessionHandoff {
  const workflow = session.metadata.workflow;
  const decisions = workflowOverride?.decisions ?? workflow?.decisions ?? [];
  const allBlockers = workflowOverride?.blockers ?? workflow?.blockers ?? [];
  const openBlockers = allBlockers.filter(b => b.status === 'open');
  const todos = workflowOverride?.todos ?? [];
  const openTodos = todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
  const currentTask = todos.find(t => t.status === 'in_progress');

  const parts: string[] = [
    `Local handoff for session "${session.name}" (${session.messages.length} messages, model ${session.model}).`,
    `${decisions.length} decisions, ${openBlockers.length} open blockers, ${openTodos.length} open todos.`,
  ];
  if (currentTask) {
    parts.push(`Current task: ${currentTask.description}.`);
  }
  if (decisions.length > 0) {
    parts.push(`Latest decision: ${decisions[decisions.length - 1].summary}.`);
  }
  parts.push('Generated from session state without an LLM call; no narrative synthesis.');

  return {
    summary: parts.join(' '),
    keyFindings: decisions.map(d => `${d.summary} (rationale: ${d.rationale})`),
    nextSteps: [...openTodos.map(t => t.description), ...openBlockers.map(b => `Resolve blocker: ${b.description}`)],
    pendingDecisions: [],
    blockers: openBlockers.map(b => b.description),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Render a full Markdown handoff document from session state. Includes
 * session metadata, all decisions and open blockers verbatim, the last
 * `LOCAL_HANDOFF_MESSAGE_TAIL` messages role-labeled and lightly truncated,
 * and a pointer to the on-disk session JSON for deeper context.
 *
 * If `session.metadata.workflow.handoff` is set (either from an LLM-generated
 * synthesis or from `buildLocalHandoff`), its narrative sections are rendered
 * at the top - so both code paths produce a single uniform artifact.
 *
 * Used as the durable artifact for `/handoff` (both LLM-backed and
 * `--local`) and for the auto-fallback when the LLM is unreachable.
 */
export function renderLocalHandoffMarkdown(session: Session, sessionJsonPath?: string): string {
  const workflow = session.metadata.workflow;
  const decisions = workflow?.decisions ?? [];
  const openBlockers = (workflow?.blockers ?? []).filter(b => b.status === 'open');
  const resolvedBlockers = (workflow?.blockers ?? []).filter(b => b.status === 'resolved');
  const tail = session.messages.filter(m => !isInjectedHandoff(m)).slice(-LOCAL_HANDOFF_MESSAGE_TAIL);
  const handoff = workflow?.handoff;

  const lines: string[] = [];
  lines.push(`# Session handoff: ${session.name}`);
  lines.push('');
  lines.push(
    'Durable artifact for resuming this session elsewhere. Captures any synthesized handoff plus decisions, open blockers, and the tail of the conversation verbatim.'
  );
  lines.push('');

  if (handoff) {
    lines.push('## Synthesized handoff');
    lines.push('');
    lines.push(handoff.summary);
    lines.push('');
    appendMarkdownSection(lines, 'Key findings', handoff.keyFindings);
    appendMarkdownSection(lines, 'Next steps', handoff.nextSteps);
    appendMarkdownSection(lines, 'Pending decisions', handoff.pendingDecisions);
    appendMarkdownSection(lines, 'Blockers', handoff.blockers);
    lines.push(`_Generated at ${handoff.generatedAt}._`);
    lines.push('');
  }

  lines.push('## Session metadata');
  lines.push('');
  lines.push(`- **Session ID:** \`${session.id}\``);
  lines.push(`- **Model:** ${session.model}`);
  lines.push(`- **Created:** ${session.createdAt}`);
  lines.push(`- **Updated:** ${session.updatedAt}`);
  lines.push(`- **Messages:** ${session.messages.length}`);
  lines.push(`- **Tool calls:** ${session.metadata.toolCallCount}`);
  lines.push(`- **Total cost:** $${session.metadata.totalCost.toFixed(4)}`);
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  if (sessionJsonPath) {
    lines.push(`- **Full session JSON:** \`${sessionJsonPath}\``);
  }
  lines.push('');

  lines.push(`## Decisions (${decisions.length})`);
  lines.push('');
  if (decisions.length === 0) {
    lines.push('_No decisions logged._');
  } else {
    for (const d of decisions) {
      lines.push(`### ${d.summary}`);
      lines.push('');
      lines.push(`- **Rationale:** ${d.rationale}`);
      if (d.alternatives && d.alternatives.length > 0) {
        lines.push(`- **Alternatives considered:** ${d.alternatives.join('; ')}`);
      }
      if (d.context) {
        lines.push(`- **Context:** ${d.context}`);
      }
      lines.push(`- **Logged at:** ${d.timestamp}`);
      lines.push('');
    }
  }

  lines.push(`## Open blockers (${openBlockers.length})`);
  lines.push('');
  if (openBlockers.length === 0) {
    lines.push('_No open blockers._');
  } else {
    for (const b of openBlockers) {
      lines.push(`- ${b.description} _(opened ${b.createdAt})_`);
    }
  }
  lines.push('');

  if (resolvedBlockers.length > 0) {
    lines.push(`## Resolved blockers (${resolvedBlockers.length})`);
    lines.push('');
    for (const b of resolvedBlockers) {
      const resolution = b.resolution ? ` → ${b.resolution}` : '';
      lines.push(`- ${b.description}${resolution}`);
    }
    lines.push('');
  }

  lines.push(`## Last ${tail.length} messages`);
  lines.push('');
  if (tail.length === 0) {
    lines.push('_No conversation messages._');
  } else {
    for (const msg of tail) {
      const role = ROLE_LABELS[msg.role] || 'System';
      const content =
        msg.content.length > LOCAL_HANDOFF_MESSAGE_CHARS
          ? msg.content.slice(0, LOCAL_HANDOFF_MESSAGE_CHARS) + '\n\n_...[truncated]_'
          : msg.content;
      lines.push(`### ${role} — ${msg.timestamp}`);
      lines.push('');
      lines.push(content);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function appendMarkdownSection(lines: string[], heading: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`**${heading}:**`);
  lines.push('');
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push('');
}

function defaultLocalHandoffDir(): string {
  return path.join(homedir(), '.bike4mind', 'handoffs');
}

function buildLocalHandoffFileName(session: Session, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${session.id}-${stamp}.md`;
}

/**
 * Write a local handoff Markdown file to `~/.bike4mind/handoffs/` and return
 * the absolute path. Creates the directory if missing. The session JSON path
 * is embedded in the markdown so the user (or another agent) can locate the
 * full session for deeper context.
 *
 * `dir` is overridable for tests.
 */
export async function writeLocalHandoffFile(
  session: Session,
  options: { dir?: string; sessionJsonPath?: string; now?: Date } = {}
): Promise<string> {
  const dir = options.dir ?? defaultLocalHandoffDir();
  const now = options.now ?? new Date();
  const sessionJsonPath =
    options.sessionJsonPath ?? path.join(homedir(), '.bike4mind', 'sessions', `${session.id}.json`);

  // Handoffs may contain the verbatim tail of a session (user/assistant
  // messages, decisions, blockers). Treat them as user-private: owner-only
  // perms on both the directory and each file so other local users can't read
  // them. `mode` on `mkdir`/`writeFile` only applies when the entry is created,
  // so existing entries keep whatever perms they already had.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, buildLocalHandoffFileName(session, now));
  const markdown = renderLocalHandoffMarkdown(session, sessionJsonPath);
  await fs.writeFile(filePath, markdown, { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

/**
 * True if an error from the LLM completion path indicates the network call
 * itself could not complete - rate limit, network drop, auth failure, or
 * upstream outage. Used to decide when to auto-fall back to the local
 * (LLM-free) handoff path.
 *
 * Conservative on purpose: a malformed-response or parse error from a server
 * that *did* answer is NOT an LLM-unavailable condition - the user can retry,
 * and falling back would mask a real bug.
 *
 * Keep the substring matches below in sync with the error strings thrown by
 * `packages/cli/src/llm/ServerLlmBackend.ts` (see its catch block around the
 * `Request failed with status` / `Authentication ...` / `Cannot connect ...`
 * / `Failed to complete LLM request` throws). Renames there will silently
 * break the auto-fallback - a typed error hierarchy would be a more robust
 * long-term fix.
 *
 * Note on 403: ServerLlmBackend throws `403 Forbidden: <details>` for
 * WAF/server-blocked requests. We deliberately do NOT classify these as
 * unavailable - a 403 typically means the user needs to take action
 * (re-auth, contact support, fix WAF rule) and silently degrading would
 * mask that. Real auth failures already surface via the `Authentication ...`
 * messages above. Add 403 here only if a concrete use case warrants it.
 */
export function isLlmUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return (
    message.includes('Rate limit exceeded') ||
    message.includes('Authentication expired') ||
    message.includes('Authentication failed') ||
    message.includes('Cannot connect to Bike4Mind server') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND') ||
    message.includes('ECONNRESET') ||
    message.includes('Failed to complete LLM request') ||
    // ServerLlmBackend wraps axios errors as "Request failed with status NNN: <text>".
    // Match the wrapped form first; the bare "5NN " prefix is kept as a belt-and-braces
    // catch for any caller that throws raw status strings.
    /Request failed with status 5\d\d/.test(message) ||
    /^5\d\d\b/.test(message)
  );
}

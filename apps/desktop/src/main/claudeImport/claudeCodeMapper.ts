import type { ChatMessage, ChatReplyRound, ChatToolCall } from '@shared/chat';
import { IMPORTED_MESSAGE_PREFIX } from '@shared/claudeImport';
import { capOutput, outputCapFor } from '../chat/tools/types';

/**
 * Claude Code transcript events (`~/.claude/projects/<slug>/<session>.jsonl`) mapped onto the
 * desktop's message model.
 *
 * Shape, as observed: one JSON event per line. `user` / `assistant` events carry an Anthropic
 * `message`; an assistant message is split across consecutive lines, one content block each,
 * sharing `message.id`. A turn is user prompt -> (assistant tool_use -> user tool_result)* ->
 * assistant text, which here becomes ONE assistant ChatMessage with a round per API message.
 * Titles arrive as `ai-title` / `custom-title` events anywhere in the file (older files used
 * `summary`). Every other type is bookkeeping and ignored, as is anything unrecognised.
 */

const PREFIX = IMPORTED_MESSAGE_PREFIX['claude-code'];

/** Same ceiling a reply's prose effectively has; a pasted log in a prompt is the usual offender. */
export const MAX_IMPORTED_TEXT_CHARS = 100_000;

/** What survives between incremental reads of one file, so appended lines continue the last turn. */
export interface CodeMapState {
  lastApiMessageId?: string;
  aiTitle?: string;
  customTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  gitBranch?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
}

/** Bytes the importer stores through AttachmentStore once the session id is settled. */
export interface PendingAttachment {
  messageId: string;
  name: string;
  mediaType: string;
  data: Buffer;
}

/**
 * Claude Code tools that have a desktop card, renamed with their arguments re-keyed so the
 * card's argument line reads them. Kept beside the permission mapping in
 * chat/permissions/rules.ts (CLAUDE_CODE_TOOLS), which governs, not displays.
 */
const TOOL_MAP: Record<string, { name: string; keys?: Record<string, string> }> = {
  Bash: { name: 'bash_execute' },
  Read: { name: 'file_read', keys: { file_path: 'path' } },
  Write: { name: 'file_write', keys: { file_path: 'path' } },
  Edit: {
    name: 'file_edit',
    keys: { file_path: 'path', old_string: 'oldText', new_string: 'newText', replace_all: 'replaceAll' },
  },
  MultiEdit: { name: 'file_edit', keys: { file_path: 'path' } },
  Grep: { name: 'grep_search' },
  Glob: { name: 'glob_files' },
  WebFetch: { name: 'web_fetch' },
  WebSearch: { name: 'web_search' },
  TodoWrite: { name: 'todo_write' },
};

export function mapToolCall(name: string, input: unknown): Pick<ChatToolCall, 'name' | 'input'> {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const mapped = TOOL_MAP[name];
  if (!mapped) return { name, input: args };
  const keys = mapped.keys ?? {};
  return {
    name: mapped.name,
    input: Object.fromEntries(Object.entries(args).map(([key, value]) => [keys[key] ?? key, value])),
  };
}

type Block = Record<string, unknown> & { type?: unknown };

function asBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter((block): block is Block => !!block && typeof block === 'object') : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Claude Code's own wrappers around app-written text, which are not the user talking. */
const APP_TAG = /^\s*<(task-notification|system-reminder|ci-monitor-event|[a-z-]+-event)>/;
const DROPPED_TAG = /^\s*<(local-command-caveat|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/;
const INTERRUPTED = /^\[Request interrupted by user/;

function slashCommand(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return asBlocks(content)
    .map(block => (block.type === 'text' ? (str(block.text) ?? '') : block.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

export function displayTitle(state: CodeMapState): string | undefined {
  return state.customTitle || state.aiTitle || state.firstPrompt;
}

/** Fold the metadata every event carries into the state; true when it was a title or move event. */
function noteMetadata(event: Record<string, unknown>, state: CodeMapState): boolean {
  const timestamp = str(event.timestamp);
  if (timestamp) {
    state.firstTimestamp ??= timestamp;
    state.lastTimestamp = timestamp;
  }
  const cwd = str(event.cwd);
  if (cwd) state.cwd = cwd;
  const branch = str(event.gitBranch);
  if (branch) state.gitBranch = branch;
  switch (event.type) {
    case 'ai-title':
      if (str(event.aiTitle)) state.aiTitle = str(event.aiTitle);
      return true;
    case 'custom-title':
      if (str(event.customTitle)) state.customTitle = str(event.customTitle);
      return true;
    case 'summary':
      if (str(event.summary)) state.aiTitle ??= str(event.summary);
      return true;
    case 'relocated':
      if (str(event.relocatedCwd)) state.cwd = str(event.relocatedCwd);
      return true;
    default:
      return false;
  }
}

/**
 * Read one event into `messages`. `includeSidechain` is for a subagent's own file, where every
 * event is a sidechain; in a main transcript sidechain turns belong to a subagent and are skipped.
 */
export function applyCodeEvent(
  event: unknown,
  messages: ChatMessage[],
  state: CodeMapState,
  attachments: PendingAttachment[],
  includeSidechain = false
): void {
  if (!event || typeof event !== 'object') return;
  const record = event as Record<string, unknown>;
  if (noteMetadata(record, state)) return;
  if (record.isSidechain === true && !includeSidechain) return;
  const uuid = str(record.uuid);
  const message = record.message as Record<string, unknown> | undefined;
  if (!uuid || !message || typeof message !== 'object') return;
  const createdAt = str(record.timestamp) ?? new Date(0).toISOString();

  if (record.type === 'user') applyUser(record, message, uuid, createdAt, messages, state, attachments);
  else if (record.type === 'assistant') applyAssistant(record, message, uuid, createdAt, messages, state);
}

function applyUser(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  uuid: string,
  createdAt: string,
  messages: ChatMessage[],
  state: CodeMapState,
  attachments: PendingAttachment[]
): void {
  if (record.isMeta === true) return;
  const blocks = asBlocks(message.content);
  const results = blocks.filter(block => block.type === 'tool_result');
  if (results.length > 0) {
    const last = messages.at(-1);
    for (const result of results) {
      const call =
        last?.role === 'assistant' ? last.toolCalls?.find(entry => entry.id === result.tool_use_id) : undefined;
      if (!call) continue;
      const text = capOutput(toolResultText(result.content), outputCapFor(call.name));
      if (result.is_error === true) {
        call.status = 'error';
        call.error = text || 'The tool reported an error.';
      } else {
        call.status = 'done';
        call.preview = text;
      }
    }
    return;
  }

  const text = blocks
    .filter(block => block.type === 'text')
    .map(block => str(block.text) ?? '')
    .join('\n\n')
    .trim();
  const imageBlocks = blocks.filter(block => block.type === 'image');
  if (!text && imageBlocks.length === 0) return;
  if (INTERRUPTED.test(text)) return;
  if (DROPPED_TAG.test(text)) return;

  const id = `${PREFIX}${uuid}`;

  if (record.isCompactSummary === true) {
    messages.push({
      id,
      role: 'user',
      content: capOutput(text, MAX_IMPORTED_TEXT_CHARS),
      createdAt,
      system: true,
      boundary: { kind: 'compact' },
    });
    return;
  }
  const command = slashCommand(text);
  const system = !command && APP_TAG.test(text);
  const content = capOutput(command ?? text, MAX_IMPORTED_TEXT_CHARS);
  messages.push({ id, role: 'user', content, createdAt, ...(system ? { system: true } : {}) });
  // Only ever a fallback title, and the state is saved per transcript: no need for all of it.
  if (!system && !state.firstPrompt && content) state.firstPrompt = content.slice(0, 200);

  imageBlocks.forEach((block, index) => {
    const source = block.source as Record<string, unknown> | undefined;
    if (source?.type !== 'base64' || typeof source.data !== 'string') return;
    const mediaType = str(source.media_type) ?? 'image/png';
    const extension = mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    attachments.push({
      messageId: id,
      name: `image-${index + 1}.${extension}`,
      mediaType,
      data: Buffer.from(source.data, 'base64'),
    });
  });
}

function applyAssistant(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  uuid: string,
  createdAt: string,
  messages: ChatMessage[],
  state: CodeMapState
): void {
  const apiId = str(message.id) ?? uuid;
  let reply = messages.at(-1);
  if (!reply || reply.role !== 'assistant' || reply.boundary) {
    reply = { id: `${PREFIX}${uuid}`, role: 'assistant', content: '', createdAt, rounds: [], toolCalls: [] };
    messages.push(reply);
    state.lastApiMessageId = undefined;
  }
  const rounds = (reply.rounds ??= []);
  let round: ChatReplyRound | undefined = rounds.at(-1);
  if (!round || state.lastApiMessageId !== apiId) {
    round = { text: '', toolCallIds: [] };
    rounds.push(round);
    state.lastApiMessageId = apiId;
  }
  if (record.isApiErrorMessage === true) {
    const text = asBlocks(message.content)
      .map(block => str(block.text) ?? '')
      .join('');
    reply.error = text || 'The request failed.';
    return;
  }

  for (const block of asBlocks(message.content)) {
    if (block.type === 'thinking') {
      const thinking = str(block.thinking)?.trim();
      if (thinking) round.reasoning = round.reasoning ? `${round.reasoning}\n\n${thinking}` : thinking;
    } else if (block.type === 'text') {
      const text = str(block.text)?.trim();
      if (!text) continue;
      round.text = round.text ? `${round.text}\n\n${text}` : text;
      reply.content = capOutput(reply.content ? `${reply.content}\n\n${text}` : text, MAX_IMPORTED_TEXT_CHARS);
    } else if (block.type === 'tool_use') {
      const id = str(block.id);
      if (!id || reply.toolCalls?.some(call => call.id === id)) continue;
      const mapped = mapToolCall(str(block.name) ?? 'tool', block.input);
      (reply.toolCalls ??= []).push({ id, ...mapped, status: 'done' });
      round.toolCallIds.push(id);
    }
  }
  // Only the stop that means "cut off" carries over; the rest are normal endings here.
  if (message.stop_reason === 'max_tokens') reply.stopReason = 'max_tokens';
}

/** Drop what a partial read can leave behind: rounds with nothing in them, empty call lists. */
export function tidyMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => {
    if (message.role !== 'assistant') return true;
    if (message.rounds) {
      message.rounds = message.rounds.filter(round => round.text || round.reasoning || round.toolCallIds.length > 0);
      if (message.rounds.length === 0) delete message.rounds;
    }
    if (message.toolCalls?.length === 0) delete message.toolCalls;
    return !!(message.content || message.toolCalls || message.rounds || message.error);
  });
}

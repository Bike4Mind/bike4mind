import type { ChatMessage, ChatReplyRound, ChatToolCall } from '@shared/chat';
import { IMPORTED_MESSAGE_PREFIX } from '@shared/claudeImport';
import { capOutput, MAX_TOOL_OUTPUT_CHARS } from '../chat/tools/types';
import { MAX_IMPORTED_TEXT_CHARS, type PendingAttachment } from './claudeCodeMapper';

/**
 * One conversation from a claude.ai export (`conversations.json`), mapped onto the desktop's
 * message model. The export is an array of
 * `{ uuid, name, summary?, created_at, updated_at, chat_messages: [...] }`, each message
 * `{ uuid, sender: 'human' | 'assistant', text, content: [blocks], created_at, attachments, files }`.
 * Blocks are text, thinking, tool_use and tool_result; attachments carry `extracted_content`,
 * and `files` are names only - the export holds no file bytes.
 */

const PREFIX = IMPORTED_MESSAGE_PREFIX['claude-chat'];
const UUID = /^[0-9a-f-]{8,64}$/i;

export interface MappedConversation {
  uuid: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  attachments: PendingAttachment[];
}

type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isoOr(value: unknown, fallback: string): string {
  const text = str(value);
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : fallback;
}

function blocksOf(message: Json): Json[] {
  return Array.isArray(message.content)
    ? message.content.filter((block): block is Json => !!block && typeof block === 'object')
    : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => (item && typeof item === 'object' ? (str((item as Json).text) ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** Null when the element is not a conversation this importer can read. */
export function mapConversation(raw: unknown): MappedConversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const conversation = raw as Json;
  const uuid = str(conversation.uuid);
  if (!uuid || !UUID.test(uuid) || !Array.isArray(conversation.chat_messages)) return null;
  const epoch = new Date(0).toISOString();
  const createdAt = isoOr(conversation.created_at, epoch);
  const updatedAt = isoOr(conversation.updated_at, createdAt);

  const messages: ChatMessage[] = [];
  const attachments: PendingAttachment[] = [];
  let firstPrompt: string | undefined;

  conversation.chat_messages.forEach((entry, position) => {
    if (!entry || typeof entry !== 'object') return;
    const message = entry as Json;
    const messageUuid = str(message.uuid);
    const id = `${PREFIX}${messageUuid && UUID.test(messageUuid) ? messageUuid : `${uuid}-${position}`}`;
    const at = isoOr(message.created_at, updatedAt);
    const blocks = blocksOf(message);

    if (message.sender === 'human') {
      const text = (
        blocks.some(block => block.type === 'text')
          ? blocks
              .filter(block => block.type === 'text')
              .map(block => str(block.text) ?? '')
              .join('\n\n')
          : (str(message.text) ?? '')
      ).trim();
      const notes: string[] = [];
      for (const [index, file] of (Array.isArray(message.attachments) ? message.attachments : []).entries()) {
        if (!file || typeof file !== 'object') continue;
        const name = str((file as Json).file_name) || `attachment-${index + 1}.txt`;
        const body = str((file as Json).extracted_content);
        if (body) attachments.push({ messageId: id, name, mediaType: 'text/plain', data: Buffer.from(body, 'utf8') });
        else notes.push(name);
      }
      for (const file of Array.isArray(message.files) ? message.files : []) {
        const name = file && typeof file === 'object' ? str((file as Json).file_name) : undefined;
        if (name) notes.push(name);
      }
      const missing = notes.length > 0 ? `\n\n[Files not included in the export: ${notes.join(', ')}]` : '';
      const content = capOutput(`${text}${missing}`.trim(), MAX_IMPORTED_TEXT_CHARS);
      if (!content && !attachments.some(attachment => attachment.messageId === id)) return;
      messages.push({ id, role: 'user', content, createdAt: at });
      if (!firstPrompt && text) firstPrompt = text;
      return;
    }

    if (message.sender !== 'assistant') return;
    const rounds: ChatReplyRound[] = [{ text: '', toolCallIds: [] }];
    const toolCalls: ChatToolCall[] = [];
    const prose: string[] = [];
    const source = blocks.length > 0 ? blocks : [{ type: 'text', text: str(message.text) ?? '' }];
    source.forEach((block, index) => {
      let round = rounds[rounds.length - 1];
      if (block.type === 'thinking') {
        const thinking = str(block.thinking)?.trim();
        if (thinking) round.reasoning = round.reasoning ? `${round.reasoning}\n\n${thinking}` : thinking;
      } else if (block.type === 'text') {
        const text = str(block.text)?.trim();
        if (!text) return;
        if (round.toolCallIds.length > 0) {
          round = { text: '', toolCallIds: [] };
          rounds.push(round);
        }
        round.text = round.text ? `${round.text}\n\n${text}` : text;
        prose.push(text);
      } else if (block.type === 'tool_use') {
        const callId = `${id}-t${index}`;
        const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
        toolCalls.push({ id: callId, name: str(block.name) ?? 'tool', input, status: 'done' });
        round.toolCallIds.push(callId);
      } else if (block.type === 'tool_result') {
        const call = toolCalls.findLast(
          entry => !entry.preview && !entry.error && (!block.name || entry.name === block.name)
        );
        if (!call) return;
        const text = capOutput(resultText(block.content), MAX_TOOL_OUTPUT_CHARS);
        if (block.is_error === true) {
          call.status = 'error';
          call.error = text || 'The tool reported an error.';
        } else call.preview = text;
      }
    });
    const kept = rounds.filter(round => round.text || round.reasoning || round.toolCallIds.length > 0);
    if (kept.length === 0) return;
    messages.push({
      id,
      role: 'assistant',
      content: capOutput(prose.join('\n\n'), MAX_IMPORTED_TEXT_CHARS),
      createdAt: at,
      rounds: kept,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  });

  const name = str(conversation.name)?.trim();
  return { uuid, title: name || firstPrompt || 'Imported chat', createdAt, updatedAt, messages, attachments };
}

import type { ChatMessage } from '@shared/chat';
import { IMPORTED_MESSAGE_PREFIX } from '@shared/claudeImport';
import { capOutput } from '../chat/tools/types';
import { MAX_IMPORTED_TEXT_CHARS } from './claudeCodeMapper';

/**
 * Bike4Mind web notebooks (`GET /api/sessions`) and their quests (`GET /api/sessions/{id}/chat`)
 * mapped onto the desktop's message model. Each quest becomes its prompt and its reply; agent
 * and tool steps, images and attached files are left out.
 */

const PREFIX = IMPORTED_MESSAGE_PREFIX['b4m-web'];
/** Mongo ObjectIds in practice; anything outside this never becomes part of a session id. */
const SOURCE_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** Quest types that are the user talking; system, oob and error rows are app-written. */
const CONVERSATION_TYPES = new Set(['message', 'voice_transcript']);

export interface WebNotebook {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Changes whenever the notebook does; compared with the cursor to decide whether to read it. */
  version: string;
}

export interface MappedQuests {
  messages: ChatMessage[];
  /** False while a reply is still being written, so the next sync reads the notebook again. */
  settled: boolean;
}

type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function iso(value: unknown): string | undefined {
  const text = str(value);
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : undefined;
}

function idOf(raw: Json): string | undefined {
  const id = str(raw.id) ?? str(raw._id);
  return id && SOURCE_ID.test(id) ? id : undefined;
}

/** Null when the list row is not a notebook this importer can read. */
export function readNotebook(raw: unknown): WebNotebook | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Json;
  const id = idOf(row);
  if (!id) return null;
  const updated = iso(row.updatedAt);
  const lastUpdated = iso(row.lastUpdated);
  const createdAt = iso(row.firstCreated) ?? iso(row.createdAt) ?? lastUpdated ?? updated ?? new Date(0).toISOString();
  const updatedAt =
    [updated, lastUpdated]
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? createdAt;
  return {
    id,
    name: str(row.name)?.trim() || 'Untitled notebook',
    createdAt,
    updatedAt,
    version: `${updated ?? ''}|${lastUpdated ?? ''}`,
  };
}

function replyOf(quest: Json): string {
  const reply = str(quest.reply);
  if (reply?.trim()) return reply.trim();
  const replies = Array.isArray(quest.replies) ? quest.replies : [];
  return (replies.find(entry => typeof entry === 'string' && entry.trim()) as string | undefined)?.trim() ?? '';
}

/** Quests in ascending order, as the chat route sorts them. */
export function mapQuests(quests: readonly unknown[], fallbackAt: string): MappedQuests {
  const messages: ChatMessage[] = [];
  const seen = new Set<string>();
  let settled = true;
  for (const entry of quests) {
    if (!entry || typeof entry !== 'object') continue;
    const quest = entry as Json;
    const id = idOf(quest);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (quest.status === 'running') settled = false;
    if (quest.deletedAt || !CONVERSATION_TYPES.has(str(quest.type) ?? 'message')) continue;
    const at = iso(quest.timestamp) ?? iso(quest.createdAt) ?? fallbackAt;
    const prompt = str(quest.prompt)?.trim() ?? '';
    if (prompt) {
      messages.push({
        id: `${PREFIX}${id}-p`,
        role: 'user',
        content: capOutput(prompt, MAX_IMPORTED_TEXT_CHARS),
        createdAt: at,
      });
    }
    const reply = replyOf(quest);
    if (reply) {
      const content = capOutput(reply, MAX_IMPORTED_TEXT_CHARS);
      messages.push({
        id: `${PREFIX}${id}-r`,
        role: 'assistant',
        content,
        createdAt: iso(quest.updatedAt) ?? at,
        rounds: [{ text: content, toolCallIds: [] }],
      });
    }
  }
  return { messages, settled };
}

// Turns a recorded session into a module's transcript. Types only, so a plain node script can import it.

export interface TutorialTurn {
  prompt: string;
  reply: string;
  uiSideEffects?: { type: string; payload: unknown }[];
  toolResults?: { tool_use_id: string; content: string; is_error?: boolean }[];
  /** The turn on which the user's own copy of the sheet rides as the quest's attachment. */
  attachSheet?: boolean;
}

export interface CapturedQuest {
  id?: string;
  status?: string;
  prompt: string;
  replies?: string[];
  createdAt?: string | Date;
  timestamp?: string | Date;
  uiSideEffects?: { type: string; payload: unknown }[];
  toolResults?: TutorialTurn['toolResults'];
  fabFileIds?: string[];
  structuredReplies?: { content?: unknown }[];
}

export const THINK = /<think>[\s\S]*?<\/think>/g;

// Fields that tie a payload to the recording session or account; the server rebinds what it needs.
const SESSION_FIELDS = ['sessionId', 'userId', 'questId'];

function replyOf(quest: CapturedQuest): string {
  return (quest.replies ?? [])
    .map(reply => reply.replace(THINK, '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function scrubPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !SESSION_FIELDS.includes(key)));
}

const timeOf = (quest: CapturedQuest) => new Date(quest.createdAt ?? quest.timestamp ?? 0).getTime();

/** One transcript turn per quest, oldest first. Refuses a session with an unfinished or failed turn. */
export function toTranscript(quests: readonly CapturedQuest[]): TutorialTurn[] {
  const ordered = [...quests].sort((a, b) => timeOf(a) - timeOf(b));
  return ordered.map((quest, turn) => {
    if (quest.status !== 'done') throw new Error(`turn ${turn} (${quest.id}) is ${quest.status}, not done`);
    const reply = replyOf(quest);
    if (!reply) throw new Error(`turn ${turn} (${quest.id}) has no reply text`);
    const effects = (quest.uiSideEffects ?? []).map(({ type, payload }) => ({ type, payload: scrubPayload(payload) }));
    return {
      prompt: quest.prompt,
      reply,
      ...(effects.length ? { uiSideEffects: effects } : {}),
      ...(quest.toolResults?.length ? { toolResults: quest.toolResults } : {}),
      ...(quest.fabFileIds?.length ? { attachSheet: true } : {}),
    };
  });
}

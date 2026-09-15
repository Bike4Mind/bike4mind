import { IMemoryEntry, MemorySource } from '@bike4mind/common';
import { randomUUID } from 'crypto';

/**
 * Function signature for LLM completion calls.
 * The caller provides this so the service stays infrastructure-free.
 */
export type LlmCompleteFn = (
  messages: { role: 'system' | 'user'; content: string }[],
  options: { maxTokens: number; temperature: number }
) => Promise<string>;

/**
 * Pure function. Formats an array of memory entries into a string suitable
 * for injection into an LLM system prompt.  Returns empty string when the
 * array is empty.
 */
export function buildMemoryPromptSection(memories: IMemoryEntry[]): string {
  if (!memories || memories.length === 0) return '';

  const lines = memories
    .slice()
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .map(m => {
      const date = new Date(m.timestamp).toISOString().slice(0, 10);
      return `- [${date}] ${m.content} (importance: ${m.importance})`;
    })
    .join('\n');

  return `## Your Memories\nYou remember the following from past interactions (most recent first):\n${lines}`;
}

/**
 * Runs a lightweight LLM call to extract 0-3 memorable facts from a
 * conversation.  Returns an empty array if extraction fails (never throws).
 */
export async function extractMemoriesFromConversation(
  agentName: string,
  personality: string,
  conversationHistory: { speaker: string; text: string }[],
  llmComplete: LlmCompleteFn
): Promise<IMemoryEntry[]> {
  if (!conversationHistory || conversationHistory.length === 0) return [];

  const formattedHistory = conversationHistory.map(h => `${h.speaker}: "${h.text}"`).join('\n');

  const systemPrompt = `You are the memory curator for ${agentName}. Your personality: ${personality}
Given the conversation below, extract 0-3 facts worth remembering.
For each, provide:
- content: 1-2 sentences capturing the essential information
- importance: 1-5 (5 = critical relationship/identity fact, 1 = passing detail)
- tags: relevant topic tags

Conversation:
${formattedHistory}

Return ONLY valid JSON array (no markdown fences):
[{ "content": "...", "importance": 3, "tags": ["topic"] }]
Return [] if nothing is worth remembering.`;

  try {
    const raw = await llmComplete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Extract memories from the conversation above.' },
      ],
      { maxTokens: 400, temperature: 0.3 }
    );

    const parsed = parseJsonArray(raw);
    const now = new Date();

    return parsed.map(
      (item): IMemoryEntry => ({
        id: randomUUID(),
        timestamp: now,
        source: 'conversation' as MemorySource,
        content: String(item.content || ''),
        importance: clampImportance(item.importance),
        tags: Array.isArray(item.tags) ? (item.tags as string[]).map(String) : [],
      })
    );
  } catch {
    // Never break the conversation flow
    return [];
  }
}

/**
 * Takes all memories, groups similar ones, uses LLM to merge.
 * Returns a consolidated array (targeting ~60% of input count).
 * Returns the original array unchanged if consolidation fails.
 */
export async function consolidateMemories(
  memories: IMemoryEntry[],
  llmComplete: LlmCompleteFn
): Promise<IMemoryEntry[]> {
  if (!memories || memories.length <= 3) return memories;

  const formattedMemories = memories
    .map(m => {
      const date = new Date(m.timestamp).toISOString().slice(0, 10);
      return `- [${date}] (importance: ${m.importance}) ${m.content}${m.tags?.length ? ` [tags: ${m.tags.join(', ')}]` : ''}`;
    })
    .join('\n');

  const systemPrompt = `You are a memory curator. Consolidate these memories, merging similar topics and dropping low-importance items older than 7 days.

Current memories:
${formattedMemories}

Return a consolidated array (aim for ${Math.ceil(memories.length * 0.6)} entries):
[{ "content": "...", "importance": 3, "tags": ["topic"] }]`;

  try {
    const raw = await llmComplete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Consolidate the memories above.' },
      ],
      { maxTokens: 800, temperature: 0.2 }
    );

    const parsed = parseJsonArray(raw);
    const now = new Date();

    return parsed.map(
      (item): IMemoryEntry => ({
        id: randomUUID(),
        timestamp: now,
        source: 'consolidation' as MemorySource,
        content: String(item.content || ''),
        importance: clampImportance(item.importance),
        tags: Array.isArray(item.tags) ? (item.tags as string[]).map(String) : [],
      })
    );
  } catch {
    // If consolidation fails, return original memories untouched
    return memories;
  }
}

/** Strip markdown fences and parse a JSON array from raw LLM output. */
function parseJsonArray(raw: string): Record<string, unknown>[] {
  const trimmed = (raw || '').trim();
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  const result = JSON.parse(cleaned);
  if (!Array.isArray(result)) return [];
  return result;
}

/** Clamp importance to 1-5 range, defaulting to 3. */
function clampImportance(val: unknown): number {
  const n = Number(val);
  if (isNaN(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

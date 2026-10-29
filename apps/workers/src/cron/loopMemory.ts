import type { ILoopMemory } from '@bike4mind/common';

/** Fallback `notes` cap (chars) when a run's answer carries no valid memory block. */
export const LOOP_MEMORY_TAIL_CHARS = 4000;

const MEMORY_FENCE = /```loop-memory[^\S\n]*\n([\s\S]*?)```/g;

/**
 * Reads the memory a run left for the next one: the LAST fenced `loop-memory`
 * JSON block in its answer. Without a valid block the answer's tail becomes the
 * notes and the previous `nextAction` is kept, so a run that ignores the format
 * still advances the loop.
 */
export function parseLoopMemory(answer: string, previous: ILoopMemory): Omit<ILoopMemory, 'updatedAt'> {
  const blocks = Array.from(answer.matchAll(MEMORY_FENCE), match => match[1]);
  const last = blocks.at(-1);
  if (last !== undefined) {
    try {
      const parsed: unknown = JSON.parse(last);
      if (parsed && typeof parsed === 'object') {
        const { notes, nextAction } = parsed as Record<string, unknown>;
        if (typeof notes === 'string' && typeof nextAction === 'string') {
          return {
            notes: notes.slice(0, LOOP_MEMORY_TAIL_CHARS),
            nextAction: nextAction.slice(0, LOOP_MEMORY_TAIL_CHARS),
          };
        }
      }
    } catch {
      // Malformed JSON falls through to the tail fallback.
    }
  }
  return { notes: answer.slice(-LOOP_MEMORY_TAIL_CHARS), nextAction: previous.nextAction };
}

/** Per-run system context: the loop's memory plus the instruction to write it back. */
export function buildLoopSystemContext(memory: ILoopMemory): string {
  return [
    'You are running as one scheduled run of a recurring loop. Nobody is watching this run live.',
    '',
    'Memory from the previous run:',
    `Notes: ${memory.notes || '(none - this is the first run)'}`,
    `Next action: ${memory.nextAction || '(none)'}`,
    '',
    'End your final answer with a fenced block tagged loop-memory holding JSON for the next run, e.g.:',
    '```loop-memory',
    '{ "notes": "what you did and learned", "nextAction": "what the next run should do first" }',
    '```',
  ].join('\n');
}

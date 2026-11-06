import { classifyMessagesOutcome, type ChildOutcome } from '@shared/agentOutcome';
import type { ChatSession } from '@shared/chat';

export type { ChildOutcome } from '@shared/agentOutcome';

export function classifyChildOutcome(child: ChatSession): ChildOutcome {
  return classifyMessagesOutcome(child.messages);
}

/**
 * The same event in the words the USER reads.
 *
 * Deliberately carries no session id and names no tool: those belong to the model's copy, which
 * needs a handle on the finished session to go and fetch its work, and reading them was what the
 * user objected to. What survives is the title - it is how several running sessions are told
 * apart - and the outcome, because a session that failed must not look like one that worked.
 *
 * Stop reasons are said plainly rather than named. "It stopped before it finished" is the fact
 * the user acts on; 'tool_turn_limit' is an implementation detail of the agent loop.
 */
export function childOutcomeDisplay(child: ChatSession): string {
  const name = `The session "${child.title}"`;
  const last = [...child.messages].reverse().find(message => message.role === 'assistant');

  switch (classifyChildOutcome(child)) {
    case 'no-reply':
      return `${name} has finished. It did not reply.`;
    case 'failed':
      return `${name} stopped with an error: ${last?.error ?? 'it did not say what went wrong'}`;
    case 'turn-budget':
      return `${name} stopped early after too many steps, so its work may be incomplete.`;
    case 'context-limit':
      return `${name} stopped early because it ran out of room, so its work may be incomplete.`;
    case 'max-tokens':
      return `${name} has finished, but its last reply was cut short.`;
    case 'aborted':
      return `${name} was stopped before it finished.`;
    default:
      return `${name} has finished.`;
  }
}

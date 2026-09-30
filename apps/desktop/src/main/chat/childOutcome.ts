import { isTurnBudgetStop, type ChatSession } from '@shared/chat';

/**
 * How a spawned session ended, classified once for the two audiences that read it.
 *
 * The parent model and the user are told different things about the same event - see
 * ChatService.describeChildOutcome for the model's half and `childOutcomeDisplay` for the
 * user's - and the two must never disagree about WHICH of these happened. So the branching
 * lives here and the wording lives in the callers.
 */
export type ChildOutcome =
  /** It answered and stopped on its own. */
  | 'finished'
  /** The run ended with no assistant turn in it at all. */
  | 'no-reply'
  /** Its last turn failed. */
  | 'failed'
  /** The agent loop's own budget ran out mid-task. See isTurnBudgetStop. */
  | 'turn-budget'
  /** It filled the model context. */
  | 'context-limit'
  /** The reply hit the length limit. */
  | 'max-tokens'
  /** Someone pressed stop. */
  | 'aborted';

export function classifyChildOutcome(child: ChatSession): ChildOutcome {
  const last = [...child.messages].reverse().find(message => message.role === 'assistant');
  if (!last) return 'no-reply';
  if (last.error) return 'failed';
  if (isTurnBudgetStop(last.stopReason)) return 'turn-budget';
  if (last.stopReason === 'context_limit') return 'context-limit';
  if (last.stopReason === 'max_tokens') return 'max-tokens';
  if (last.stopReason === 'aborted') return 'aborted';
  return 'finished';
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

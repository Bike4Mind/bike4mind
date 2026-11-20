import type { AgentCheckpoint, AgentStep } from '@bike4mind/agents';

export const LOW_CONFIDENCE_REOPEN_NUDGE =
  'The user asked you to reconsider this answer: it rests on low-confidence evidence. ' +
  'Verify the claims it depends on before answering again, and say plainly what you could not confirm.';

/**
 * Reopen the final answer a completion-time `block` pause parked, the way `ReActAgent`'s
 * `reopenAnswerWithFeedback` reopens one mid-run: the answer becomes a thought, the transcript gets
 * the answer plus a verify nudge as the next user turn, and the nudge is recorded as a step so the
 * trace shows why the run continued. The resumed run therefore ends with one `final_answer`.
 *
 * Returns `null` when the checkpoint does not end on a final answer (nothing to reopen).
 */
export function reopenLowConfidenceAnswer(checkpoint: AgentCheckpoint, now = Date.now()): AgentCheckpoint | null {
  const last = checkpoint.steps.at(-1);
  if (last?.type !== 'final_answer') return null;
  const iteration = last.metadata?.iteration;
  const iterationMeta = iteration !== undefined ? { iteration } : {};
  const reopenedAnswer: AgentStep = {
    type: 'thought',
    content: last.content,
    metadata: { timestamp: last.metadata?.timestamp ?? now, ...iterationMeta },
  };
  const nudgeStep: AgentStep = {
    type: 'observation',
    content: LOW_CONFIDENCE_REOPEN_NUDGE,
    metadata: { timestamp: now, ...iterationMeta },
  };
  return {
    ...checkpoint,
    steps: [...checkpoint.steps.slice(0, -1), reopenedAnswer, nudgeStep],
    messages: [
      ...checkpoint.messages,
      { role: 'assistant', content: last.content },
      { role: 'user', content: LOW_CONFIDENCE_REOPEN_NUDGE },
    ],
  };
}

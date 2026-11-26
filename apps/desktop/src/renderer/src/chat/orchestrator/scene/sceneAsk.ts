import type { PendingDecision } from '@shared/pendingDecisions';
import { ASK_USER_TOOL_NAME, parseQuestions, RECOMMENDED_SUFFIX } from '@shared/questions';
import { approvalSummary } from '@shared/watch';
import { truncate } from './bubbleText';

const ASK_MAX = 60;
const OPTION_MAX = 18;
const OPTIONS_SHOWN = 4;

/**
 * How an ask ended, as far as the renderer can tell. `elsewhere`: it went away while the agent moved on
 * without an answer from this scene (the dock, the menu bar, the mini window, or the agent was stopped).
 * There is no `expired`: no approval in the renderer carries an expiry.
 */
export type AskOutcome = 'approved' | 'denied' | 'answered' | 'elsewhere';
export type AskState = 'waiting' | AskOutcome;

export const ASK_STATE_LABEL: Record<AskState, string> = {
  waiting: 'Waiting',
  approved: 'Approved',
  denied: 'Denied',
  answered: 'Answered',
  elsewhere: 'Answered elsewhere',
};

/** What an agent is asking, short enough for the bubble over its head. */
export interface SceneAsk {
  /** The tool and its target (the same one-line summary the menu bar shows), or the question. */
  what: string;
  /** A question's option faces, at most OPTIONS_SHOWN. */
  options: string[];
}

const face = (label: string) =>
  truncate(label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label, OPTION_MAX);

function question(text: string, labels: readonly string[]): SceneAsk {
  return { what: truncate(text, ASK_MAX), options: labels.slice(0, OPTIONS_SHOWN).map(face) };
}

export function sceneAskOf(decision: PendingDecision): SceneAsk {
  switch (decision.kind) {
    case 'approval': {
      const { call } = decision;
      if (call.name === ASK_USER_TOOL_NAME) {
        const parsed = parseQuestions(call.input.questions);
        if (!('error' in parsed) && parsed.questions.length > 0) {
          const [first] = parsed.questions;
          return question(
            first.question,
            first.options.map(option => option.label)
          );
        }
      }
      // A card that collects secrets keeps its details to the session; the bubble names the tool only.
      return { what: truncate(decision.collectsSecrets ? call.name : approvalSummary(call), ASK_MAX), options: [] };
    }
    case 'question':
      return question(
        decision.decision.question.question,
        decision.decision.question.options.map(option => option.label)
      );
    case 'held-relay':
      return { what: 'A relayed message to deliver', options: [] };
    case 'stopped':
      return { what: 'Paused before finishing', options: [] };
    case 'error':
      return { what: truncate(`Failed: ${decision.error}`, ASK_MAX), options: [] };
  }
}

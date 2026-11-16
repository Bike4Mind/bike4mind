import type { ChatToolCall } from '@shared/chat';
import { REQUEST_DIRECTORY_TOOL_NAME } from '@shared/directoryRequest';
import { isMcpConfigToolName } from '@shared/mcp';
import { ASK_USER_TOOL_NAME, type ChatQuestion, parseQuestions, RECOMMENDED_SUFFIX } from '@shared/questions';
import { describeToolInput } from '@shared/toolDetail';

/** Longest option face the bubble draws as a button; a longer one needs the full card to read. */
export const BUBBLE_OPTION_MAX = 24;

// An option that reads as destroying or discarding something is never one click from across the room.
const DESTRUCTIVE = /\b(delete|remove|drop|destroy|discard|erase|wipe|purge|reset|overwrite|force|revert)\b/i;

/** Where a choice made in the bubble is sent: a worker task's decision, or an ask_user card at the approval gate. */
export type BubbleTarget = { via: 'decision'; decisionId: string } | { via: 'approval'; approvalId: string };

export type BubbleOption = { label: string; face: string; recommended: boolean };

/**
 * What the "needs you" bubble offers for one waiting agent. Anything that needs more than a yes or no
 * to answer safely (a choice of approvals, an irreversible call, a directory or MCP request, a long
 * or free-text question) is `open`: the bubble sends the user to the full card instead.
 */
export type BubblePlan =
  | { kind: 'approve'; approvalId: string; summary: string }
  | { kind: 'choose'; prompt: string; options: BubbleOption[]; target: BubbleTarget }
  | { kind: 'open'; prompt?: string };

/** A question the bubble can answer with one click per option, or `open` when it cannot. */
export function planForQuestion(question: ChatQuestion, target: BubbleTarget): BubblePlan {
  const prompt = question.question;
  if (question.multiSelect) return { kind: 'open', prompt };
  const options = question.options.map(option => {
    const recommended = option.label.endsWith(RECOMMENDED_SUFFIX);
    const face = recommended ? option.label.slice(0, -RECOMMENDED_SUFFIX.length) : option.label;
    return { label: option.label, face, recommended };
  });
  const oneClick = options.every(option => option.face.length <= BUBBLE_OPTION_MAX && !DESTRUCTIVE.test(option.face));
  return oneClick ? { kind: 'choose', prompt, options, target } : { kind: 'open', prompt };
}

/** The first call parked at the approval gate, as the bubble can answer it. */
export function planForCall(call: ChatToolCall | undefined): BubblePlan {
  if (!call?.approvalId) return { kind: 'open' };
  const approvalId = call.approvalId;
  if (call.name === ASK_USER_TOOL_NAME) {
    const parsed = parseQuestions(call.input.questions);
    if ('error' in parsed || parsed.questions.length !== 1) return { kind: 'open' };
    return planForQuestion(parsed.questions[0], { via: 'approval', approvalId });
  }
  const summary = `${call.name} ${describeToolInput(call)}`.trim();
  const needsCard =
    call.name === REQUEST_DIRECTORY_TOOL_NAME ||
    isMcpConfigToolName(call.name) ||
    call.approvalChoice !== undefined ||
    call.approvalIrreversible === true;
  return needsCard ? { kind: 'open', prompt: summary } : { kind: 'approve', approvalId, summary };
}

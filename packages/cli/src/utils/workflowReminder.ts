import type { TodoItem } from '../tools/writeTodosTool.js';
import type { WorkflowBlocker, WorkflowDecision } from '../storage/types.js';

/**
 * Renders the compact per-iteration workflow reminder body handed to
 * `AgentRunOptions.workflowReminder` (the agents package owns placement and
 * marker tagging; this module owns content and the token budget).
 *
 * Budget contract (issue: context-budget requirement): steady state ~300-500
 * tokens, hard cap DEFAULT_REMINDER_MAX_TOKENS. Enforced by (a) rendering only
 * open todos / open blockers / the most recent K decisions, (b) one-line
 * elision of long text, (c) dropping oldest-first until the render fits.
 * Because the agent replaces the reminder in place each iteration, this is a
 * fixed ceiling, not a per-turn accumulation.
 */

/** Hard cap on the rendered reminder, in approximate tokens. */
export const DEFAULT_REMINDER_MAX_TOKENS = 800;

/** Most recent decisions shown before budget pressure drops any. */
export const REMINDER_RECENT_DECISIONS = 5;

/** Per-line elision caps (chars) keeping single items from eating the budget. */
const MAX_ITEM_CHARS = 160;

export interface WorkflowReminderState {
  todos: TodoItem[];
  decisions: WorkflowDecision[];
  blockers: WorkflowBlocker[];
}

export interface WorkflowReminderRender {
  /** Rendered reminder body, or null when there is no open state to show. */
  text: string | null;
  /** Items dropped to fit the token cap - surface this, don't hide it. */
  elided: number;
}

/**
 * Cheap chars/4 token approximation. The cap is a safety ceiling, not exact
 * accounting, so an estimator beats pulling a tokenizer into this hot path
 * (the provider runs before every LLM call).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function elide(text: string, maxChars = MAX_ITEM_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 3)}...` : oneLine;
}

function render(todoLines: string[], blockerLines: string[], decisionLines: string[]): string {
  const sections: string[] = [];
  if (todoLines.length > 0) sections.push(`Open todos:\n${todoLines.join('\n')}`);
  if (blockerLines.length > 0) sections.push(`Open blockers:\n${blockerLines.join('\n')}`);
  if (decisionLines.length > 0) sections.push(`Recent decisions:\n${decisionLines.join('\n')}`);
  return sections.join('\n\n');
}

/**
 * Render the current working state as a compact reminder body.
 *
 * Never exceeds `maxTokens` (approximate): when over budget, items are
 * dropped oldest-first - decisions (oldest first), then blockers, then todos
 * (todos last because they are the plan the model steers by). The number of
 * dropped items is reported via `elided` so callers can log the truncation
 * rather than silently hiding state.
 */
export function renderWorkflowReminder(
  state: WorkflowReminderState,
  options: { maxTokens?: number } = {}
): WorkflowReminderRender {
  const maxTokens = options.maxTokens ?? DEFAULT_REMINDER_MAX_TOKENS;

  const openTodos = state.todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
  const openBlockers = state.blockers.filter(b => b.status === 'open');
  const recentDecisions = state.decisions.slice(-REMINDER_RECENT_DECISIONS);
  // Decisions beyond the recent-K window are elided by design; count them so
  // the truncation stays observable alongside budget-pressure drops.
  let elided = state.decisions.length - recentDecisions.length;

  const todoLines = openTodos.map((t, i) => `${i + 1}. [${t.status}] ${elide(t.description)}`);
  const blockerLines = openBlockers.map(b => `- ${elide(b.description)}`);
  const decisionLines = recentDecisions.map(d => `- ${elide(d.summary)} (rationale: ${elide(d.rationale, 100)})`);

  if (todoLines.length === 0 && blockerLines.length === 0 && decisionLines.length === 0) {
    return { text: null, elided };
  }

  let text = render(todoLines, blockerLines, decisionLines);
  // Terminates: every pass removes one line, and an empty render costs 0 tokens.
  while (estimateTokens(text) > maxTokens) {
    if (decisionLines.length > 0) decisionLines.shift();
    else if (blockerLines.length > 0) blockerLines.shift();
    else todoLines.shift();
    elided++;
    text = render(todoLines, blockerLines, decisionLines);
  }

  return { text: text.length > 0 ? text : null, elided };
}

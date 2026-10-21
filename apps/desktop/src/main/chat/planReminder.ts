import { TODO_TOOL_NAME, type TodoItem } from '@shared/todos';

/** Tool rounds a turn may run without touching the plan before it is nudged about it. */
export const PLAN_REMINDER_ROUNDS = 3;

/**
 * The nudge a running turn gets when its plan has gone cold, or null when it has not.
 *
 * The plan is model-driven and nothing else keeps it honest: the card is exactly as fresh as
 * the last todo_write and the model reliably finishes an item, says so in prose, and forgets to
 * mark it. Pure so the policy can be tested without a conversation behind it.
 *
 * Fires every PLAN_REMINDER_ROUNDS rounds rather than once, so a turn that keeps ignoring it is
 * asked again; a successful todo_write resets the caller's count and re-arms it from zero.
 */
export function stalePlanReminder(plan: readonly TodoItem[] | null, roundsSinceUpdate: number): string | null {
  if (!plan || plan.length === 0) return null;
  if (plan.every(item => item.status === 'completed')) return null;
  if (roundsSinceUpdate <= 0 || roundsSinceUpdate % PLAN_REMINDER_ROUNDS !== 0) return null;
  return reminder(
    `The plan the user sees still has unfinished items and has not changed in ${roundsSinceUpdate} rounds.`,
    `If any of them are now started or done, send ${TODO_TOOL_NAME} with the whole list.`,
    'If it already matches what has happened, carry on. Either way do not mention this reminder.'
  );
}

/**
 * The nudge carried into the NEXT turn when the one just ended left an item in progress.
 *
 * Only in_progress counts. A turn that ends with pending items is ordinary - the model asked a
 * question, or the user stopped it - but nothing stops work mid-item on purpose, so an item
 * left in progress is a forgotten update rather than a state anyone chose.
 */
export function unfinishedPlanReminder(plan: readonly TodoItem[] | null): string | null {
  const open = plan?.find(item => item.status === 'in_progress');
  if (!open) return null;
  return reminder(
    `Your previous reply ended the turn with "${open.content}" still in progress on the plan.`,
    `Send ${TODO_TOOL_NAME} with the whole list first: mark it completed if it is done, or pending`,
    'if it was never started. Then answer what was asked, without mentioning this reminder.'
  );
}

function reminder(...lines: string[]): string {
  return ['<system-reminder>', ...lines, '</system-reminder>'].join('\n');
}

import { z } from 'zod';

/**
 * Frequency control for the proactive "this turn looks wrong" feedback prompt (#1873).
 *
 * The prompt is worth showing only to someone still willing to explain, and a false positive is
 * expensive in a way a missed report is not: an affordance that nags gets tuned out, and a tuned-out
 * affordance cannot be un-tuned-out by fixing the detector later. So the caps are deliberately
 * tighter than the detector is accurate.
 *
 * Two layers live here; the third - only ever prompting under one turn, the last one rendered - is
 * the caller's, because which turn that is depends on render state rather than anything to persist.
 *
 *  1. Per turn. A waved-off turn stays waved off across reloads and remounts, so the prompt never
 *     re-asks about an answer the user already declined to talk about.
 *  2. Per day. Once someone has waved off DAILY_DISMISSAL_BUDGET prompts in one day they have said
 *     "not today" clearly enough; stop asking until tomorrow.
 *
 * Only a decline spends the daily budget. Acting on the prompt is engagement, and charging for it
 * would make the feature quietest for the users most willing to use it.
 *
 * Every read degrades to "not dismissed, not capped" on a storage failure: losing this state costs
 * one extra prompt, and that is strictly cheaper than throwing inside a message render.
 */

export const ANSWER_FEEDBACK_DISMISSED_TURNS_KEY = 'b4m:answerFeedbackPrompt:dismissedTurns';
export const ANSWER_FEEDBACK_DAILY_DISMISSALS_KEY = 'b4m:answerFeedbackPrompt:dailyDismissals';

// Bounded so a long-lived browser profile cannot grow this without limit. Oldest entries fall off
// first, and the worst case is one extra prompt on a turn declined a very long time ago.
const MAX_DISMISSED_TURNS = 200;

/**
 * Three declines in a day is an unambiguous "not interested right now". Kept low on purpose: one
 * prompt too few costs a report we never receive, one too many costs every future report from a
 * user who has learned to ignore the banner.
 */
export const DAILY_DISMISSAL_BUDGET = 3;

// Filtered element-wise rather than validated whole-list: one corrupt entry must not discard the
// other 199 and re-ask about every turn the user already waved off. Matches staleModelPrompt.ts.
const dismissedTurnsSchema = z
  .array(z.unknown())
  .catch([])
  .transform(entries => entries.filter((entry): entry is string => typeof entry === 'string'));

const dailyDismissalsSchema = z
  .object({ date: z.string(), count: z.number().int().nonnegative() })
  .catch({ date: '', count: 0 });

/** Local calendar day, so the budget resets at the user's midnight rather than UTC's. */
const today = (): string => {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

function readJson<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return schema.parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable - the prompt simply gets another chance later.
  }
}

export function isAnswerFeedbackPromptDismissed(questId: string): boolean {
  return readJson(ANSWER_FEEDBACK_DISMISSED_TURNS_KEY, dismissedTurnsSchema, []).includes(questId);
}

/** True once today's declines have spent the budget, whatever turn is being considered. */
export function isAnswerFeedbackPromptCapped(): boolean {
  const record = readJson(ANSWER_FEEDBACK_DAILY_DISMISSALS_KEY, dailyDismissalsSchema, { date: '', count: 0 });
  return record.date === today() && record.count >= DAILY_DISMISSAL_BUDGET;
}

/** Records a decline: silences this turn for good, and spends one of today's three. */
export function dismissAnswerFeedbackPrompt(questId: string): void {
  const dismissed = readJson(ANSWER_FEEDBACK_DISMISSED_TURNS_KEY, dismissedTurnsSchema, []);
  writeJson(
    ANSWER_FEEDBACK_DISMISSED_TURNS_KEY,
    [...dismissed.filter(id => id !== questId), questId].slice(-MAX_DISMISSED_TURNS)
  );

  // Re-dismissing a turn already on the list must not spend the budget twice, or a remount that
  // re-renders a dismissed prompt could silently burn the day.
  if (dismissed.includes(questId)) return;

  const record = readJson(ANSWER_FEEDBACK_DAILY_DISMISSALS_KEY, dailyDismissalsSchema, { date: '', count: 0 });
  const date = today();
  writeJson(ANSWER_FEEDBACK_DAILY_DISMISSALS_KEY, {
    date,
    count: record.date === date ? record.count + 1 : 1,
  });
}

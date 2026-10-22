import type { ChatQuestion, ChatQuestionAnswer } from '@shared/questions';

export interface QuestionPick {
  selected: string[];
  otherOn: boolean;
  other: string;
}

export const emptyPicks = (questions: readonly ChatQuestion[]): QuestionPick[] =>
  questions.map(() => ({ selected: [], otherOn: false, other: '' }));

export function toggleOption(
  picks: QuestionPick[],
  index: number,
  question: ChatQuestion,
  label: string
): QuestionPick[] {
  return picks.map((pick, i) => {
    if (i !== index) return pick;
    if (!question.multiSelect) return { ...pick, selected: [label], otherOn: false };
    const selected = pick.selected.includes(label) ? pick.selected.filter(l => l !== label) : [...pick.selected, label];
    return { ...pick, selected };
  });
}

export function toggleOther(picks: QuestionPick[], index: number, question: ChatQuestion): QuestionPick[] {
  return picks.map((pick, i) => {
    if (i !== index) return pick;
    if (!question.multiSelect) return { ...pick, selected: [], otherOn: true };
    return { ...pick, otherOn: !pick.otherOn };
  });
}

/** Typing is choosing Other: a single-select answer cannot be both an option and free text. */
export function typeOther(picks: QuestionPick[], index: number, question: ChatQuestion, text: string): QuestionPick[] {
  return picks.map((pick, i) => {
    if (i !== index) return pick;
    return { selected: question.multiSelect ? pick.selected : [], otherOn: true, other: text };
  });
}

export function isAnswered(pick: QuestionPick): boolean {
  return pick.selected.length > 0 || (pick.otherOn && pick.other.trim().length > 0);
}

export const isComplete = (picks: readonly QuestionPick[]): boolean => picks.length > 0 && picks.every(isAnswered);

export function toAnswers(picks: readonly QuestionPick[]): ChatQuestionAnswer[] {
  return picks.map(pick => {
    const other = pick.otherOn ? pick.other.trim() : '';
    return other ? { selected: pick.selected, other } : { selected: pick.selected };
  });
}

/** The first question still waiting on an answer, after `from`, else `from` itself. */
export function nextUnanswered(picks: readonly QuestionPick[], from: number): number {
  for (let step = 1; step <= picks.length; step += 1) {
    const candidate = (from + step) % picks.length;
    if (!isAnswered(picks[candidate])) return candidate;
  }
  return from;
}

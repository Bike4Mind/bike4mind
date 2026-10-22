export const ASK_USER_TOOL_NAME = 'ask_user';

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_CHARS = 12;
export const MAX_QUESTION_CHARS = 300;
export const MAX_LABEL_CHARS = 60;
export const MAX_DESCRIPTION_CHARS = 300;
export const MAX_OTHER_CHARS = 4000;

export interface ChatQuestionOption {
  label: string;
  description: string;
}

export interface ChatQuestion {
  question: string;
  header: string;
  options: ChatQuestionOption[];
  multiSelect?: boolean;
}

/** One question's reply: option labels, and/or what the user typed on the always-present "Other" row. */
export interface ChatQuestionAnswer {
  selected: string[];
  other?: string;
}

/**
 * How a question card ended. Folded into the call's own input as `outcome` so the stored row
 * carries everything the settled card draws - there is no second store to keep in step.
 */
export type ChatQuestionOutcome =
  { status: 'answered'; answers: ChatQuestionAnswer[] } | { status: 'skipped' } | { status: 'cancelled' };

const FALLBACK_HEADER = 'Question';
const RECOMMENDED_SUFFIX = ' (Recommended)';
const ELLIPSIS = '\u2026';
const CUT_BOUNDARY = /[\s\-+/]/;

/**
 * `text` fitted to `max` characters, ending in an ellipsis when it had to be cut.
 *
 * Cuts at a word, hyphen, `+` or `/` boundary when that keeps at least half the room, so
 * "deployment target" reads "deployment..." rather than "deployment t...".
 */
export function fitText(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - ELLIPSIS.length;
  for (let index = room; index >= Math.ceil(room / 2); index--) {
    if (!CUT_BOUNDARY.test(text[index])) continue;
    const head = text.slice(0, index).replace(/[\s\-+/]+$/, '');
    if (head.length >= Math.ceil(room / 2)) return head + ELLIPSIS;
  }
  return text.slice(0, room).trimEnd() + ELLIPSIS;
}

/** A label fitted to `max`, keeping a trailing " (Recommended)" the model put on its pick. */
function fitLabel(text: string, max: number): string {
  if (text.length <= max || !text.endsWith(RECOMMENDED_SUFFIX)) return fitText(text, max);
  return fitText(text.slice(0, -RECOMMENDED_SUFFIX.length), max - RECOMMENDED_SUFFIX.length) + RECOMMENDED_SUFFIX;
}

const oneLine = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/**
 * The questions an `ask_user` call carries, or why it is not a valid one.
 *
 * Shared by the tool, which refuses a bad call so the model corrects it, and by the renderer,
 * which draws the card from the call's own input. Only what the model must fix is refused; a
 * header, label or description over its display length is fitted instead, so a cosmetic limit
 * never costs the user the question. Fitting is idempotent: ChatService stores the fitted
 * questions on the call, and every later parse of them returns them unchanged.
 */
export function parseQuestions(value: unknown): { questions: ChatQuestion[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'The "questions" argument is required and must be a non-empty array.' };
  }
  if (value.length > MAX_QUESTIONS) return { error: `Ask at most ${MAX_QUESTIONS} questions at once.` };

  const questions: ChatQuestion[] = [];
  const seenQuestions = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const label = `Question ${index + 1}`;
    const item = entry as Record<string, unknown> | null;
    if (typeof item !== 'object' || item === null) return { error: `${label} must be an object.` };

    const question = typeof item.question === 'string' ? item.question.trim() : '';
    if (!question) return { error: `${label} needs a non-empty "question".` };
    if (question.length > MAX_QUESTION_CHARS) {
      return { error: `${label} is over ${MAX_QUESTION_CHARS} characters; shorten it.` };
    }
    if (seenQuestions.has(question.toLowerCase())) return { error: `${label} repeats an earlier question.` };
    seenQuestions.add(question.toLowerCase());

    const header = fitText(oneLine(item.header), MAX_HEADER_CHARS) || FALLBACK_HEADER;

    if (!Array.isArray(item.options)) return { error: `${label} needs an "options" array.` };
    if (item.options.length < MIN_OPTIONS || item.options.length > MAX_OPTIONS) {
      return { error: `${label} needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options; the UI adds "Other" itself.` };
    }
    if (item.multiSelect !== undefined && typeof item.multiSelect !== 'boolean') {
      return { error: `${label} "multiSelect" must be true or false.` };
    }

    const options: ChatQuestionOption[] = [];
    const seenLabels = new Set<string>();
    for (const [optionIndex, rawOption] of item.options.entries()) {
      const where = `${label} option ${optionIndex + 1}`;
      const option = rawOption as Record<string, unknown> | null;
      if (typeof option !== 'object' || option === null) return { error: `${where} must be an object.` };
      const givenLabel = oneLine(option.label);
      if (!givenLabel) return { error: `${where} needs a non-empty "label".` };
      if (/^other\b/i.test(givenLabel)) {
        return { error: `${where} is an "Other" option; do not include one, the UI adds it.` };
      }
      const optionLabel = fitLabel(givenLabel, MAX_LABEL_CHARS);
      if (seenLabels.has(optionLabel.toLowerCase())) {
        // Two labels that only collide once shortened were distinct as sent, so say why.
        return optionLabel === givenLabel
          ? { error: `${label} has two options labelled "${optionLabel}"; labels must be unique.` }
          : {
              error: `${label} has two options that both read "${optionLabel}" at ${MAX_LABEL_CHARS} characters; make the labels differ sooner.`,
            };
      }
      seenLabels.add(optionLabel.toLowerCase());
      const description = typeof option.description === 'string' ? option.description.trim() : '';
      if (!description) return { error: `${where} needs a non-empty "description".` };
      options.push({ label: optionLabel, description: fitText(description, MAX_DESCRIPTION_CHARS) });
    }

    questions.push({ question, header, options, ...(item.multiSelect === true ? { multiSelect: true } : {}) });
  }
  return { questions };
}

/**
 * What the renderer sent, held to what the card could have produced: only labels the question
 * offered, one of them unless it is multi-select, and a bounded "Other" text. One entry per
 * question, whatever came in.
 */
export function sanitizeAnswers(questions: readonly ChatQuestion[], raw: unknown): ChatQuestionAnswer[] {
  const given = Array.isArray(raw) ? raw : [];
  return questions.map((question, index) => {
    const entry = (given[index] ?? {}) as { selected?: unknown; other?: unknown };
    const offered = new Set(question.options.map(option => option.label));
    const picked = Array.isArray(entry.selected)
      ? [...new Set(entry.selected.filter((label): label is string => typeof label === 'string' && offered.has(label)))]
      : [];
    const other = typeof entry.other === 'string' ? entry.other.trim().slice(0, MAX_OTHER_CHARS) : '';
    const selected = question.multiSelect ? picked : picked.slice(0, 1);
    // A single-select answer is one thing: typed text replaces a pick rather than joining it.
    return other ? { selected: question.multiSelect ? selected : [], other } : { selected };
  });
}

export function parseOutcome(value: unknown): ChatQuestionOutcome | null {
  const outcome = value as { status?: unknown; answers?: unknown } | null;
  if (typeof outcome !== 'object' || outcome === null) return null;
  if (outcome.status === 'skipped' || outcome.status === 'cancelled') return { status: outcome.status };
  if (outcome.status === 'answered' && Array.isArray(outcome.answers)) {
    return { status: 'answered', answers: outcome.answers as ChatQuestionAnswer[] };
  }
  return null;
}

/** One answer as prose: the labels, then the typed text. Empty when the user left it blank. */
export function describeAnswer(answer: ChatQuestionAnswer | undefined): string {
  if (!answer) return '';
  const parts = answer.selected.map(label => `"${label}"`);
  if (answer.other) parts.push(`Other: "${answer.other}"`);
  return parts.join(', ');
}

/** The tool result the model reads. */
export function formatQuestionResult(questions: readonly ChatQuestion[], outcome: ChatQuestionOutcome): string {
  if (outcome.status === 'skipped') {
    return 'The user skipped these questions without answering. Proceed with your best judgment, or stop and ask in plain text if you cannot continue without an answer.';
  }
  if (outcome.status === 'cancelled') {
    return 'The question was cancelled: the user stopped the reply or sent a new message instead. Do not ask it again unless you still need it, and follow their new message if there is one.';
  }
  const lines = questions.map(
    (question, index) => `"${question.question}" -> ${describeAnswer(outcome.answers[index]) || '(no answer)'}`
  );
  return ['The user answered your questions:', ...lines, 'Continue with these answers in mind.'].join('\n');
}

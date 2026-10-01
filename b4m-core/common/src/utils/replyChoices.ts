/**
 * Reply choices: the discrete next steps a reply offers, rendered as numbered buttons.
 *
 * The model ends a reply with a fenced `choices` block; the server strips it with
 * {@link extractChoicesBlock} and persists the options on the quest as `suggestedChoices`.
 * Keys are positional (1..n in block order) so they match the prose numbering above the block.
 * The option shape matches the CLI's ask_user_question options.
 */

export interface ChoiceOption {
  label: string;
  description: string;
}

export interface SuggestedChoices {
  options: ChoiceOption[];
  /** Zero-based index of the option the user picked, once they pick one. */
  selectedIndex?: number;
}

export const CHOICES_FENCE_LANGUAGE = 'choices';
export const MIN_REPLY_CHOICES = 2;
export const MAX_REPLY_CHOICES = 4;
export const MAX_CHOICE_LABEL_LENGTH = 40;
export const MAX_CHOICE_DESCRIPTION_LENGTH = 300;

export interface ExtractedChoices {
  /** The reply with the trailing block removed; the input unchanged when there was none. */
  text: string;
  /** Validated options, or null when there was no block or it failed validation. */
  choices: ChoiceOption[] | null;
  /** True when a trailing block was found and stripped, valid or not. */
  found: boolean;
}

const OPEN_FENCE = /(^|\n)[ \t]*```choices[ \t]*(?=\r?\n|$)/g;
const BODY_THEN_CLOSE = /^\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*```\s*$/;

/**
 * Strips a trailing ```choices block from a reply and validates its options.
 *
 * Only the last block counts, and only when nothing but whitespace follows it; a block mid-reply
 * is ordinary content. A block that is unterminated (a truncated reply) or invalid is still
 * stripped so the reader never sees raw JSON. Any invalid option rejects the whole block, because
 * dropping one would shift the numbering away from the prose.
 */
export function extractChoicesBlock(reply: string): ExtractedChoices {
  let lastOpen: RegExpExecArray | null = null;
  for (const match of reply.matchAll(OPEN_FENCE)) lastOpen = match;
  if (!lastOpen || lastOpen.index === undefined) return { text: reply, choices: null, found: false };

  const fenceStart = lastOpen.index + lastOpen[1].length;
  const rest = reply.slice(lastOpen.index + lastOpen[0].length);
  const closed = rest.match(BODY_THEN_CLOSE);
  // Unclosed means truncated mid-block - but only if no other content could be hiding in it.
  const unterminated = !closed && !rest.includes('```');
  if (!closed && !unterminated) return { text: reply, choices: null, found: false };

  const text = reply.slice(0, fenceStart).trimEnd();
  const choices = closed ? parseChoiceOptions(closed[1]) : null;
  return { text, choices, found: true };
}

function parseChoiceOptions(body: string): ChoiceOption[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { options?: unknown }).options)
      ? (parsed as { options: unknown[] }).options
      : null;
  if (!raw) return null;

  const options: ChoiceOption[] = [];
  for (const item of raw.slice(0, MAX_REPLY_CHOICES)) {
    if (!item || typeof item !== 'object') return null;
    const { label, description } = item as { label?: unknown; description?: unknown };
    if (typeof label !== 'string' || typeof description !== 'string') return null;
    const cleanLabel = label.trim();
    const cleanDescription = description.trim();
    if (!cleanLabel || cleanLabel.length > MAX_CHOICE_LABEL_LENGTH) return null;
    if (!cleanDescription || cleanDescription.length > MAX_CHOICE_DESCRIPTION_LENGTH) return null;
    options.push({ label: cleanLabel, description: cleanDescription });
  }
  return options.length >= MIN_REPLY_CHOICES ? options : null;
}

/**
 * Zero-based option index for a prompt that is only a choice key (`2`, `2.`, `2)`, `#2`),
 * or null when the prompt is anything more or the key is out of range.
 */
export function parseChoiceKey(prompt: string, optionCount: number): number | null {
  const match = prompt.match(/^\s*#?\s*(\d)\s*[.)]?\s*$/);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < optionCount ? index : null;
}

/** The user-visible text a picked option sends as the user's reply. */
export function formatChoiceReply(option: ChoiceOption): string {
  return `${option.label}: ${option.description}`;
}

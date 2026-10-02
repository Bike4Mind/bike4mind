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

const OPEN_FENCE = /(^|\n)[ \t]*```choices[ \t]*(?=\r?\n|$)/gi;
// A standalone closing fence line: 3+ backticks, optionally padded with spaces, nothing else on
// the line. Matched as the first one found after the open fence rather than anchored to the
// reply's end, so a model that pads the fence or adds a sign-off after it doesn't leave the raw
// block in the text - see extractChoicesBlock below.
const CLOSE_FENCE = /\r?\n[ \t]*`{3,}[ \t]*(?=\r?\n|$)/;

/**
 * Strips a trailing ```choices block from a reply and validates its options.
 *
 * Only the last block counts; a block mid-reply is ordinary content. Once an open fence is found,
 * everything from there to its closing fence - and anything after that fence - is treated as the
 * block, so the reader never sees raw JSON even when the model doesn't follow the exact format:
 * a truncated reply, a closing fence padded with extra backticks, a different letter case on
 * `choices`, or trailing prose appended after the block all get stripped the same way. Any invalid
 * option rejects the whole block, because dropping one would shift the numbering away from the prose.
 */
export function extractChoicesBlock(reply: string): ExtractedChoices {
  let lastOpen: RegExpExecArray | null = null;
  for (const match of reply.matchAll(OPEN_FENCE)) lastOpen = match;
  if (!lastOpen || lastOpen.index === undefined) return { text: reply, choices: null, found: false };

  const fenceStart = lastOpen.index + lastOpen[1].length;
  const rest = reply.slice(lastOpen.index + lastOpen[0].length);
  const close = rest.match(CLOSE_FENCE);
  const text = reply.slice(0, fenceStart).trimEnd();
  // No standalone closing fence anywhere after the open fence: a truncated mid-stream block.
  if (!close || close.index === undefined) return { text, choices: null, found: true };

  const choices = parseChoiceOptions(rest.slice(0, close.index));
  return { text, choices, found: true };
}

/**
 * {@link extractChoicesBlock} over every reply slot (one per completion when n > 1). Options come
 * from the first slot carrying a valid block; every slot is stripped either way.
 */
export function stripChoicesFromReplies(replies: readonly string[]): {
  replies: string[];
  choices: ChoiceOption[] | null;
  found: boolean;
} {
  let choices: ChoiceOption[] | null = null;
  let found = false;
  const stripped = replies.map(slot => {
    const result = extractChoicesBlock(slot);
    if (!result.found) return slot;
    found = true;
    choices ??= result.choices;
    return result.text;
  });
  return { replies: stripped, choices, found };
}

function parseChoiceOptions(body: string): ChoiceOption[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
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
  const seenLabels = new Set<string>();
  for (const item of raw.slice(0, MAX_REPLY_CHOICES)) {
    if (!item || typeof item !== 'object') return null;
    const { label, description } = item as { label?: unknown; description?: unknown };
    if (typeof label !== 'string' || typeof description !== 'string') return null;
    const cleanLabel = label.trim();
    const cleanDescription = description.trim();
    if (!cleanLabel || cleanLabel.length > MAX_CHOICE_LABEL_LENGTH) return null;
    if (!cleanDescription || cleanDescription.length > MAX_CHOICE_DESCRIPTION_LENGTH) return null;
    // A duplicate label would render two buttons with identical visible text.
    if (seenLabels.has(cleanLabel)) return null;
    seenLabels.add(cleanLabel);
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

/** System guidance telling the model when and how to end a reply with a choices block. */
export const REPLY_CHOICES_GUIDANCE = [
  '# Reply choices',
  '',
  `When your reply ends by asking the user to pick between ${MIN_REPLY_CHOICES} and ${MAX_REPLY_CHOICES} concrete next actions,`,
  'write the options in your prose as usual, then end the reply with one fenced block in the',
  `\`${CHOICES_FENCE_LANGUAGE}\` language holding the same options in the same order. The app turns it into numbered buttons.`,
  '',
  '```' + CHOICES_FENCE_LANGUAGE,
  '{"options":[{"label":"Short name","description":"The whole option in one sentence."}]}',
  '```',
  '',
  `- label: 1 to 3 words, at most ${MAX_CHOICE_LABEL_LENGTH} characters.`,
  `- description: the whole option in one sentence, at most ${MAX_CHOICE_DESCRIPTION_LENGTH} characters, worded so it reads correctly when sent back as the user's own reply.`,
  '- The block must be the very last thing in the reply, and there is at most one.',
  '- Do not add a block for steps the user carries out themselves, ranked results or examples,',
  '  an open question that needs a typed answer, or a single recommendation the user simply accepts or redirects.',
  `- If the user asks to see or discuss this format itself, show it in a \`json\` fence, never a \`${CHOICES_FENCE_LANGUAGE}\` one, so the example is not turned into buttons.`,
].join('\n');

/**
 * Finalize step for a completed reply: strips a trailing choices block from `replies` and `reply`
 * and sets `suggestedChoices` (cleared when this reply offered none, so a regenerated turn never
 * keeps the previous answer's buttons). Mutates `quest`.
 */
export function applyReplyChoices(quest: {
  reply?: string | null;
  replies?: string[];
  suggestedChoices?: SuggestedChoices;
}): void {
  const fromSlots = stripChoicesFromReplies(quest.replies ?? []);
  const fromReply = typeof quest.reply === 'string' ? extractChoicesBlock(quest.reply) : null;
  if (fromSlots.found) quest.replies = fromSlots.replies;
  if (fromReply?.found) quest.reply = fromReply.text;
  const options = fromSlots.choices ?? fromReply?.choices ?? null;
  quest.suggestedChoices = options ? { options } : undefined;
}

/**
 * Expands a prompt that is only a choice key into that option's reply text, when `choices` are
 * still open (offered and not yet picked). Anything else passes through with `pickedIndex` null.
 */
export function expandChoiceKey(
  prompt: string,
  choices: SuggestedChoices | undefined
): { prompt: string; pickedIndex: number | null } {
  if (!choices || choices.selectedIndex != null) return { prompt, pickedIndex: null };
  const index = parseChoiceKey(prompt, choices.options.length);
  if (index === null) return { prompt, pickedIndex: null };
  return { prompt: formatChoiceReply(choices.options[index]), pickedIndex: index };
}

/**
 * Reply choices: the discrete next steps a reply offers, rendered as numbered buttons.
 *
 * The model ends a reply with a fenced `choices` block; the server strips it with
 * {@link extractChoicesBlock} and persists the options on the quest as `suggestedChoices`.
 * Keys are positional (1..n in block order) so they match the prose numbering above the block.
 * The option shape matches the CLI's ask_user_question options.
 */

import { THINK_OPEN_TAG, visibleReplyText } from './streamVisibility';

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

/** Why a choices block produced no buttons. Machine-readable; persisted on promptMeta.replyChoices. */
export const REPLY_CHOICES_INVALID_REASONS = [
  'json',
  'shape',
  'label_length',
  'description_length',
  'duplicate_label',
  'too_few',
  'unterminated',
  'think_unclosed',
] as const;
export type ReplyChoicesInvalidReason = (typeof REPLY_CHOICES_INVALID_REASONS)[number];

/**
 * What became of a reply's choices block: `parsed` (buttons), `absent` (no block in the final
 * answer), or `invalid` with the first rule it broke. Must stay in sync with the Zod
 * `PromptMetaZodSchema.replyChoices` in ../schemas/promptMeta.ts.
 */
export type ReplyChoicesOutcome =
  { status: 'parsed' } | { status: 'absent' } | { status: 'invalid'; reason: ReplyChoicesInvalidReason };

export interface ExtractedChoices {
  /** The reply with the block removed; the input unchanged when there was none. */
  text: string;
  /** Validated options, or null when there was no block or it failed validation. */
  choices: ChoiceOption[] | null;
  /** True when a block was found and stripped, valid or not. */
  found: boolean;
  outcome: ReplyChoicesOutcome;
}

const ABSENT: ReplyChoicesOutcome = { status: 'absent' };
const invalid = (reason: ReplyChoicesInvalidReason): ReplyChoicesOutcome => ({ status: 'invalid', reason });

interface FenceSpan {
  /** Offset of the open fence line. */
  start: number;
  /** Offset just past the closing fence line, or null when the block is still open at the end. */
  end: number | null;
  body: string;
}

const FENCE_OPEN_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_LINE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/**
 * Offset where a slot's visible answer starts: just past its last top-level `</think>`, 0 when it
 * has none, or null while a `<think>` is still open. Depth-tracked to match visibleReplyText in
 * ./streamVisibility.ts, so a marker-shaped string inside reasoning cannot end it early.
 */
function answerStart(reply: string): number | null {
  let depth = 0;
  let start = 0;
  for (const marker of reply.matchAll(/<\/?think>/g)) {
    if (marker[0] === THINK_OPEN_TAG) depth += 1;
    else if (depth > 0) {
      depth -= 1;
      if (depth === 0) start = (marker.index ?? 0) + marker[0].length;
    }
  }
  return depth === 0 ? start : null;
}

/**
 * The last top-level ```choices fence in `text`, walking fences line by line (CommonMark rules: a
 * fence closes on a bare line of the same character at least as long), so a choices sample nested
 * inside a longer outer fence is content rather than a block.
 */
function findLastChoicesFence(text: string): FenceSpan | null {
  let last: FenceSpan | null = null;
  let open: { start: number; bodyStart: number; marker: string; isChoices: boolean } | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (!open) {
      const match = line.match(FENCE_OPEN_LINE);
      // Per CommonMark a backtick fence's info string cannot contain a backtick (that line is inline code).
      if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
        open = {
          start: lineStart,
          bodyStart: newline === -1 ? text.length : newline + 1,
          marker: match[1],
          isChoices: match[1] === '```' && match[2].trim().toLowerCase() === CHOICES_FENCE_LANGUAGE,
        };
      }
    } else {
      const match = line.match(FENCE_CLOSE_LINE);
      if (match && match[1][0] === open.marker[0] && match[1].length >= open.marker.length) {
        if (open.isChoices) last = { start: open.start, end: lineEnd, body: text.slice(open.bodyStart, lineStart) };
        open = null;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  // Still open at the end: a block cut off mid-stream, hidden so its raw JSON never shows.
  if (open?.isChoices) last = { start: open.start, end: null, body: text.slice(open.bodyStart) };
  return last;
}

/**
 * Strips the last ```choices block from a reply's visible answer and validates its options.
 *
 * Only the text after the slot's last `</think>` is eligible, so a block the model drafted while
 * reasoning is never read, and the reasoning prefix is returned byte-for-byte. Nothing visible is
 * deleted: prose the model added after the block's closing fence is kept, with only the block
 * removed. A block still open at the end (truncated, or streaming) is hidden through to the end.
 * Any invalid option rejects the whole block, because dropping one would shift the numbering away
 * from the prose.
 */
export function extractChoicesBlock(reply: string): ExtractedChoices {
  const unchanged = { text: reply, choices: null, found: false, outcome: ABSENT };
  const start = answerStart(reply);
  // Reported, not read: a block inside an unclosed <think> is still reasoning.
  if (start === null) {
    return findLastChoicesFence(reply) ? { ...unchanged, outcome: invalid('think_unclosed') } : unchanged;
  }
  const answer = reply.slice(start);
  const fence = findLastChoicesFence(answer);
  if (!fence) return unchanged;

  const before = answer.slice(0, fence.start).trimEnd();
  const after = fence.end === null ? '' : answer.slice(fence.end).replace(/^(?:[ \t]*\r?\n)+/, '');
  const kept = after.trim() ? (before ? `${before}\n\n${after}` : after) : before;
  const parsed = fence.end === null ? { reason: 'unterminated' as const } : parseChoiceOptions(fence.body);
  const text = reply.slice(0, start) + kept;
  return 'options' in parsed
    ? { text, choices: parsed.options, found: true, outcome: { status: 'parsed' } }
    : { text, choices: null, found: true, outcome: invalid(parsed.reason) };
}

/**
 * {@link extractChoicesBlock} over the reply slots. Only the last slot with visible text - the
 * final answer - is read and stripped; earlier slots (reasoning, or a pre-tool-call answer) are
 * returned untouched, so an abandoned draft block can never supply the options.
 */
export function stripChoicesFromReplies(replies: readonly string[]): {
  replies: string[];
  choices: ChoiceOption[] | null;
  found: boolean;
  outcome: ReplyChoicesOutcome;
} {
  const stripped = [...replies];
  let answerIndex = stripped.length - 1;
  while (answerIndex >= 0 && !visibleReplyText(stripped[answerIndex])) answerIndex -= 1;
  if (answerIndex < 0) return { replies: stripped, choices: null, found: false, outcome: ABSENT };

  const result = extractChoicesBlock(stripped[answerIndex]);
  if (result.found) stripped[answerIndex] = result.text;
  return { replies: stripped, choices: result.choices, found: result.found, outcome: result.outcome };
}

type ParsedOptions = { options: ChoiceOption[] } | { reason: ReplyChoicesInvalidReason };

function parseChoiceOptions(body: string): ParsedOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return { reason: 'json' };
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { options?: unknown }).options)
      ? (parsed as { options: unknown[] }).options
      : null;
  if (!raw) return { reason: 'shape' };

  const options: ChoiceOption[] = [];
  const seenLabels = new Set<string>();
  for (const item of raw.slice(0, MAX_REPLY_CHOICES)) {
    if (!item || typeof item !== 'object') return { reason: 'shape' };
    const { label, description } = item as { label?: unknown; description?: unknown };
    if (typeof label !== 'string' || typeof description !== 'string') return { reason: 'shape' };
    const cleanLabel = label.trim();
    const cleanDescription = description.trim();
    if (!cleanLabel || cleanLabel.length > MAX_CHOICE_LABEL_LENGTH) return { reason: 'label_length' };
    if (!cleanDescription || cleanDescription.length > MAX_CHOICE_DESCRIPTION_LENGTH) {
      return { reason: 'description_length' };
    }
    // A duplicate label would render two buttons with identical visible text.
    if (seenLabels.has(cleanLabel)) return { reason: 'duplicate_label' };
    seenLabels.add(cleanLabel);
    options.push({ label: cleanLabel, description: cleanDescription });
  }
  return options.length >= MIN_REPLY_CHOICES ? { options } : { reason: 'too_few' };
}

/**
 * A choices block in exactly the {@link REPLY_CHOICES_GUIDANCE} format, for re-attaching stored
 * options to an assistant turn in model-facing history (finalize strips the block from the stored
 * reply, so without it the model's own history teaches it to omit the block). Only label and
 * description are emitted - never selectedIndex or any other stored field.
 */
export function formatChoicesBlock(options: readonly ChoiceOption[]): string {
  const payload = { options: options.map(({ label, description }) => ({ label, description })) };
  return '\n\n```' + CHOICES_FENCE_LANGUAGE + '\n' + JSON.stringify(payload) + '\n```';
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
 * keeps the previous answer's buttons). Mutates `quest`. Returns why buttons did or did not appear;
 * when neither source parsed, the slots' outcome wins unless they had no block at all.
 */
export function applyReplyChoices(quest: {
  reply?: string | null;
  replies?: string[];
  suggestedChoices?: SuggestedChoices;
}): ReplyChoicesOutcome {
  const fromSlots = stripChoicesFromReplies(quest.replies ?? []);
  const fromReply = typeof quest.reply === 'string' ? extractChoicesBlock(quest.reply) : null;
  if (fromSlots.found) quest.replies = fromSlots.replies;
  if (fromReply?.found) quest.reply = fromReply.text;
  const options = fromSlots.choices ?? fromReply?.choices ?? null;
  quest.suggestedChoices = options ? { options } : undefined;
  if (options) return { status: 'parsed' };
  return fromSlots.outcome.status !== 'absent' ? fromSlots.outcome : (fromReply?.outcome ?? ABSENT);
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

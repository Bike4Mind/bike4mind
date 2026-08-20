import { escapeSlackText } from '@bike4mind/services';

/**
 * Fields this module reads out of a feedback submission's (already-redacted)
 * promptMeta. Deliberately NOT typed as PromptMeta: this is an explicit read
 * allowlist for what a Slack summary is allowed to show, so a future field
 * added to PromptMeta doesn't silently start flowing into a third-party
 * workspace just because the type happens to be structurally compatible.
 */
export interface FeedbackPromptMetaInput {
  model?: { name?: string };
  tokenUsage?: {
    totalTokens?: number;
    actualTotalTokens?: number;
    actualInputTokens?: number;
    actualOutputTokens?: number;
    estimatedCost?: number;
  };
  finishReason?: string;
  functionCalls?: Array<{ name?: string }> | null;
  citables?: unknown[];
  context?: { lakeMemory?: { beliefCount?: number; dataLakeTags?: string[] } };
}

const MAX_FUNCTION_CALL_NAMES = 5;
const MAX_DATA_LAKE_TAGS = 5;
// Slack's incoming-webhook `text` has a documented ~40k character ceiling, but a crafted
// submission pushing anywhere near that turns into a delivery failure (and the alarm noise
// that follows) rather than just an unreadable message - cap well under it so an oversized
// field truncates the message instead of losing it.
const MAX_MESSAGE_CHARS = 3000;

/** `$1.23e-7` / `$0.30000000000000004` -> a plain, short decimal string. */
function formatCost(cost: number): string {
  return String(parseFloat(cost.toFixed(4)));
}

/** Joins the first `max` items, appending a "+N more" marker for anything past that. */
function joinWithOverflow(items: string[], max: number): string {
  const shown = items.slice(0, max);
  const overflow = items.length - shown.length;
  return overflow > 0 ? `${shown.join(', ')}, +${overflow} more` : shown.join(', ');
}

/** `text.slice(0, max)`, but drops a trailing lone UTF-16 high surrogate rather than
 * splitting a surrogate pair (which would render as a replacement character). */
function truncateSafely(text: string, max: number): string {
  const sliced = text.slice(0, max);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Every field this module interpolates onto a single labeled line (`*Label:* <value>`) goes
 * through this, never bare `escapeSlackText`. Slack mrkdwn has no escape for newlines, so an
 * unescaped one lets a value forge what reads as an extra top-level `*Label:*` line elsewhere
 * in the message - collapsing is lossless here since every caller of this helper is a
 * single-line value by nature. `content` is the one exception: it's blockquoted instead
 * (see `toBlockquote`) so its own real line breaks survive.
 */
function escapeLine(text: string): string {
  return escapeSlackText(text).replace(/[\r\n]+/g, ' ');
}

/**
 * A short, readable summary of the diagnostic signals that matter for triaging a bug
 * report - not a dump of the full object (unreadable, and Slack truncates long messages
 * anyway). Uses `!== undefined` throughout: a zero token count or a zero belief count
 * (the epic's own zero-retrieval signal, at context.lakeMemory.beliefCount) is meaningful
 * and must not be swallowed by a truthy check.
 */
export function buildPromptMetaSummary(promptMeta: FeedbackPromptMetaInput | null | undefined): string {
  if (!promptMeta) return 'none';

  const lines: string[] = [];

  if (promptMeta.model?.name !== undefined) {
    lines.push(`Model: ${escapeLine(promptMeta.model.name)}`);
  }

  const tokenUsage = promptMeta.tokenUsage;
  // actualTotalTokens is a field the completion pipeline has never actually populated (it
  // writes actualInputTokens/actualOutputTokens instead) - sum those as a further fallback so
  // a real completion's usage isn't silently dropped just because the summed field is absent.
  // Only sums when BOTH halves are present - a lone actualInputTokens or actualOutputTokens
  // isn't a total, and rendering it as one would misrepresent a partial number as the whole.
  const actualSum =
    tokenUsage?.actualInputTokens !== undefined && tokenUsage?.actualOutputTokens !== undefined
      ? tokenUsage.actualInputTokens + tokenUsage.actualOutputTokens
      : undefined;
  const totalTokens = tokenUsage?.totalTokens ?? tokenUsage?.actualTotalTokens ?? actualSum;
  const cost = tokenUsage?.estimatedCost;
  // Rendered whenever EITHER is present, not gated on totalTokens alone - a cost recorded
  // without a token total (or vice versa) would otherwise silently vanish from the summary.
  if (totalTokens !== undefined || cost !== undefined) {
    const tokensPart = totalTokens !== undefined ? `${totalTokens}` : 'unknown';
    const costPart = cost !== undefined ? `, est. cost $${formatCost(cost)}` : '';
    lines.push(`Tokens: ${tokensPart}${costPart}`);
  }

  if (promptMeta.finishReason !== undefined) {
    lines.push(`Finish reason: ${escapeLine(promptMeta.finishReason)}`);
  }

  const functionCalls = promptMeta.functionCalls;
  if (functionCalls != null) {
    const names = functionCalls
      .map(fc => fc.name)
      .filter((name): name is string => name !== undefined)
      .map(escapeLine);
    const namesPart = names.length ? ` (${joinWithOverflow(names, MAX_FUNCTION_CALL_NAMES)})` : '';
    lines.push(`Tool calls: ${functionCalls.length}${namesPart}`);
  }

  // Independent of the functionCalls branch above - a citation-only turn (citables present,
  // no functionCalls) must not silently lose this diagnostic.
  if (promptMeta.citables?.length !== undefined) {
    lines.push(`Citables: ${promptMeta.citables.length}`);
  }

  const lakeMemory = promptMeta.context?.lakeMemory;
  if (lakeMemory?.beliefCount !== undefined) {
    const tags = lakeMemory.dataLakeTags?.map(escapeLine) ?? [];
    const tagsPart = tags.length ? ` (${joinWithOverflow(tags, MAX_DATA_LAKE_TAGS)})` : '';
    lines.push(`Lake beliefs: ${lakeMemory.beliefCount}${tagsPart}`);
  }

  return lines.length ? lines.join('\n') : 'none';
}

export interface FeedbackSlackMessageInput {
  /** Non-prod stage marker, e.g. `*[pr-1234]*\n`; empty string on production. */
  stagePrefix: string;
  type: string;
  organization: string;
  username: string;
  userEmail: string;
  userId: string;
  /** User-supplied report text - escaped and blockquoted here, never interpolated raw. */
  content: string;
  /** Already redacted (functionCalls[].returnValue/.error stripped) by the caller. */
  promptMeta?: FeedbackPromptMetaInput | null;
}

/**
 * Slack mrkdwn has no escape for `*`/`_`/newlines, so a multi-line `content` value could
 * otherwise inject what reads as extra top-level `*Label:*` lines into the message.
 * Blockquoting every line (each prefixed with `> `) keeps injected lines visually nested
 * under "Feedback:" instead of sitting as siblings of the real fields above them.
 */
function toBlockquote(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

/**
 * Builds the Slack mrkdwn message for a feedback report. Every user-influenced string is
 * escaped before interpolation - unescaped, a value like `<https://example/|Open record>`
 * renders as a live Slack link indistinguishable from a real one, and on the unauthenticated
 * submission path type/username/userEmail/userId are raw request-body values, the same
 * exposure class as content. The identity fields and the promptMeta summary's string fields
 * all go through escapeLine, which also collapses newlines - each shares a line with its own
 * `*Label:*`, so an unescaped newline could otherwise forge a fake extra field. `content` is
 * blockquoted instead so its own real line breaks survive. The result is capped to
 * MAX_MESSAGE_CHARS so an oversized field (a huge `content`, an unbounded `model.name`)
 * truncates the delivered message rather than failing to send at all. Prompt Meta sits last,
 * so an oversized submission loses the diagnostic summary before it loses the identity
 * fields or the feedback text itself - the more actionable half of the message for triage.
 */
export function buildFeedbackSlackMessage(input: FeedbackSlackMessageInput): string {
  const { stagePrefix, type, organization, username, userEmail, userId, content, promptMeta } = input;
  const message =
    `${stagePrefix}*Type:* ${escapeLine(type)}\n` +
    `*User Details:* ${escapeLine(organization)} - ${escapeLine(username)} (ID: ${escapeLine(userId)})\n` +
    `*User Email:* ${escapeLine(userEmail)}\n` +
    `*Feedback:*\n${toBlockquote(escapeSlackText(content))}\n` +
    `\n*Prompt Meta:* ${buildPromptMetaSummary(promptMeta)}`;
  return message.length > MAX_MESSAGE_CHARS ? `${truncateSafely(message, MAX_MESSAGE_CHARS)}... [truncated]` : message;
}

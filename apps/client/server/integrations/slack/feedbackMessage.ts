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
// This posts via a legacy incoming-webhook { text: message } payload (see postFeedbackToSlack),
// whose ceiling is ~40k characters - not Block Kit's much lower per-text-object limit, which
// doesn't apply here. Cap well under 40k so a crafted submission pushing toward it turns into a
// truncated-but-delivered message (and no alarm noise) rather than a delivery failure, while
// staying generous enough that an ordinary long bug report (pasted logs, repro steps) isn't cut.
const MAX_MESSAGE_CHARS = 20000;
// Each identity field is capped far below MAX_MESSAGE_CHARS so the five of them together can
// never consume the budget content/Prompt Meta need - without this, a single oversized `type`
// or `username` (raw body values with no length constraint of their own) could truncate away
// the feedback text or the diagnostic summary despite being the least useful thing to keep.
const MAX_IDENTITY_FIELD_CHARS = 200;

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

// The full Unicode line-terminator set (CR, LF, TAB, VT, FF, NEL, LINE/PARAGRAPH SEPARATOR),
// matching the collapse-to-single-line convention already established elsewhere in this repo
// for the identical threat (see agentExecutor.firstIterationQuery.ts's escapePreambleFilename
// and getFirstIterationMementosPreamble.ts's sanitizeSummary) - CR/LF alone misses TAB/VT/FF/
// U+0085/U+2028/U+2029, which Slack's white-space: pre-wrap rendering also treats as breaks.
const LINE_TERMINATORS = /\r\n|[\r\n\t\v\f\u0085\u2028\u2029]/g;

/**
 * Every field this module interpolates onto a single labeled line (`*Label:* <value>`) goes
 * through this, never bare `escapeSlackText`. Slack mrkdwn has no escape for line-terminator
 * characters, so an unescaped one lets a value forge what reads as an extra top-level
 * `*Label:*` line elsewhere in the message - collapsing is lossless here since every caller of
 * this helper is a single-line value by nature. `content` is the one exception: it's
 * blockquoted instead (see `toBlockquote`) so its own real line breaks survive.
 */
function escapeLine(text: string): string {
  return escapeSlackText(text).replace(LINE_TERMINATORS, ' ');
}

/**
 * Escapes and collapses like `escapeLine`, then caps to MAX_IDENTITY_FIELD_CHARS - for the
 * five identity fields specifically, none of which have a length constraint at the request
 * schema, so a single oversized one shouldn't be able to truncate content/Prompt Meta away.
 */
function escapeIdentityField(text: string): string {
  return truncateSafely(escapeLine(text), MAX_IDENTITY_FIELD_CHARS);
}

/**
 * A short, readable summary of the diagnostic signals that matter for triaging a bug
 * report - not a dump of the full object (unreadable, and Slack truncates long messages
 * anyway). Checks `!== undefined` (or `!= null`) rather than truthiness for every numeric
 * field: a zero token count or a zero belief count (the epic's own zero-retrieval signal,
 * at context.lakeMemory.beliefCount) is meaningful and must not be swallowed. `citables` is
 * the one array-presence check (`if (promptMeta.citables)`), which reads clearer and behaves
 * the same, since an empty array is still truthy and still renders `Citables: 0`.
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
  if (promptMeta.citables) {
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
 * Slack mrkdwn has no escape for line-terminator characters, so a multi-line `content` value
 * could otherwise inject what reads as extra top-level `*Label:*` lines into the message.
 * Blockquoting every line (each prefixed with `> `) keeps injected lines visually nested
 * under "Feedback:" instead of sitting as siblings of the real fields above them. Splits on
 * the same LINE_TERMINATORS class as `escapeLine` (CRLF kept as one break, not two).
 */
function toBlockquote(text: string): string {
  return text
    .split(LINE_TERMINATORS)
    .map(line => `> ${line}`)
    .join('\n');
}

/**
 * Builds the Slack mrkdwn message for a feedback report. `type` and `content` are raw request
 * body values (`index.ts:29-36,129`); the identity fields (`username`/`userEmail`/`userId`)
 * are resolved server-side from the caller's own record either way (JWT or API-key auth -
 * `index.ts:76-81`) and escaped here for defense in depth, not because a specific forgery path
 * exists. Every field is escaped before interpolation - unescaped, a value like
 * `<https://example/|Open record>` renders as a live Slack link indistinguishable from a real
 * one. The identity fields and the promptMeta summary's string fields all go through
 * `escapeLine`, which also collapses line-terminator characters, since each shares a line with
 * its own `*Label:*` and an unescaped one could otherwise forge a fake extra field; `content`
 * is blockquoted instead so its own real line breaks survive. `*`/`_` are left unescaped (Slack
 * has no backslash escape for them) as an accepted residual - the line-terminator collapse and
 * the blockquote are what keep a crafted field off its own line, which is what actually
 * matters. Each identity field is capped (`escapeIdentityField`) and the whole result capped to
 * `MAX_MESSAGE_CHARS`, so an oversized field truncates the delivered message rather than
 * failing to send, with Prompt Meta (least actionable for triage) truncated away first.
 */
export function buildFeedbackSlackMessage(input: FeedbackSlackMessageInput): string {
  const { stagePrefix, type, organization, username, userEmail, userId, content, promptMeta } = input;
  const message =
    `${stagePrefix}*Type:* ${escapeIdentityField(type)}\n` +
    `*User Details:* ${escapeIdentityField(organization)} - ${escapeIdentityField(username)} (ID: ${escapeIdentityField(userId)})\n` +
    `*User Email:* ${escapeIdentityField(userEmail)}\n` +
    `*Feedback:*\n${toBlockquote(escapeSlackText(content))}\n` +
    `\n*Prompt Meta:* ${buildPromptMetaSummary(promptMeta)}`;
  return message.length > MAX_MESSAGE_CHARS ? `${truncateSafely(message, MAX_MESSAGE_CHARS)}... [truncated]` : message;
}

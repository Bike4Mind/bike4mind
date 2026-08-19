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
  tokenUsage?: { totalTokens?: number; actualTotalTokens?: number; estimatedCost?: number };
  finishReason?: string;
  functionCalls?: Array<{ name?: string }> | null;
  citables?: unknown[];
  context?: { lakeMemory?: { beliefCount?: number; dataLakeTags?: string[] } };
}

const MAX_FUNCTION_CALL_NAMES = 5;

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
    lines.push(`Model: ${escapeSlackText(promptMeta.model.name)}`);
  }

  const tokenUsage = promptMeta.tokenUsage;
  const totalTokens = tokenUsage?.totalTokens ?? tokenUsage?.actualTotalTokens;
  if (totalTokens !== undefined) {
    const cost = tokenUsage?.estimatedCost !== undefined ? `, est. cost $${tokenUsage.estimatedCost}` : '';
    lines.push(`Tokens: ${totalTokens}${cost}`);
  }

  if (promptMeta.finishReason !== undefined) {
    lines.push(`Finish reason: ${escapeSlackText(promptMeta.finishReason)}`);
  }

  const functionCalls = promptMeta.functionCalls;
  if (functionCalls != null) {
    const names = functionCalls
      .map(fc => fc.name)
      .filter((name): name is string => name !== undefined)
      .slice(0, MAX_FUNCTION_CALL_NAMES)
      .map(escapeSlackText);
    const citableCount = promptMeta.citables?.length;
    const citablePart = citableCount !== undefined ? `, ${citableCount} citable(s)` : '';
    lines.push(`Tool calls: ${functionCalls.length}${names.length ? ` (${names.join(', ')})` : ''}${citablePart}`);
  }

  const lakeMemory = promptMeta.context?.lakeMemory;
  if (lakeMemory?.beliefCount !== undefined) {
    const tags = lakeMemory.dataLakeTags?.map(escapeSlackText).join(', ');
    lines.push(`Lake beliefs: ${lakeMemory.beliefCount}${tags ? ` (${tags})` : ''}`);
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
  /** User-supplied report text - escaped here, never interpolated raw. */
  content: string;
  /** Already redacted (functionCalls[].returnValue/.error stripped) by the caller. */
  promptMeta?: FeedbackPromptMetaInput | null;
}

/**
 * Builds the Slack mrkdwn message for a feedback report. Every user-influenced string
 * (content, username, userEmail, type, organization, userId) is escaped via
 * escapeSlackText before interpolation - unescaped, a value like
 * `<https://example/|Open record>` renders as a live Slack link indistinguishable
 * from a real one, and on the unauthenticated submission path username/userEmail/type
 * are raw request-body values, the same exposure class as content.
 */
export function buildFeedbackSlackMessage(input: FeedbackSlackMessageInput): string {
  const { stagePrefix, type, organization, username, userEmail, userId, content, promptMeta } = input;
  return (
    `${stagePrefix}*Type:* ${escapeSlackText(type)}\n` +
    `*User Details:* ${escapeSlackText(organization)} - ${escapeSlackText(username)} (ID: ${escapeSlackText(userId)})\n` +
    `*User Email:* ${escapeSlackText(userEmail)}\n` +
    `*Feedback:* ${escapeSlackText(content)}\n` +
    `\n*Prompt Meta:* ${buildPromptMetaSummary(promptMeta)}`
  );
}

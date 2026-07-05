/**
 * Shared template for the SRE Agent's "No Fix Needed" (`wont_fix`) GitHub
 * issue comment. Used by both the initial-analysis path (`sreAnalysis.ts`)
 * and the revision path (`sreRevision.ts`) so the two variants stay in sync.
 *
 * LLM-generated fields are run through `escapeMarkdown` to prevent Markdown
 * injection and to neutralize `@`-mention auto-linking (which would otherwise
 * ping real GitHub users/teams from a hallucinated handle).
 */

import { escapeMarkdown } from '@server/utils/markdownEscape';

/** HTML marker used to dedup `wont_fix` comments on a single issue. */
export const WONT_FIX_COMMENT_MARKER = '<!-- sre-wont-fix -->';

/** Max characters of rootCause/proposedFix surfaced to the GH comment. */
export const WONT_FIX_FIELD_MAX_CHARS = 500;

export type WontFixVariant = 'initial' | 'revision';

export interface WontFixDiagnosis {
  rootCause?: string;
  proposedFix?: string;
  confidence: number;
}

/**
 * Build the body of the `wont_fix` GitHub issue comment.
 *
 * @param diagnosis - the (re-)diagnosis result; rootCause/proposedFix are
 *                    LLM-generated and will be escaped before interpolation.
 * @param variant   - 'initial' for the first analysis pass, 'revision' for
 *                    the post-review re-diagnosis path. Only changes the
 *                    header wording.
 */
export function buildWontFixCommentBody(diagnosis: WontFixDiagnosis, variant: WontFixVariant): string {
  const headerSuffix = variant === 'revision' ? ' (Revision)' : '';
  const verb = variant === 'revision' ? 'Re-diagnosis' : 'Diagnosis';
  const rootCause = diagnosis.rootCause
    ? escapeMarkdown(diagnosis.rootCause.slice(0, WONT_FIX_FIELD_MAX_CHARS))
    : 'N/A';
  const reason = diagnosis.proposedFix
    ? escapeMarkdown(diagnosis.proposedFix.slice(0, WONT_FIX_FIELD_MAX_CHARS))
    : 'N/A';
  return [
    WONT_FIX_COMMENT_MARKER,
    `**SRE Agent — No Fix Needed${headerSuffix}**`,
    '',
    `${verb} completed but found no code changes are required.`,
    '',
    `*Root cause:* ${rootCause}`,
    `*Reason:* ${reason}`,
    `*Confidence:* ${diagnosis.confidence}%`,
  ].join('\n');
}

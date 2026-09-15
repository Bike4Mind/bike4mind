import path from 'path';
import type { CodeMinifier } from '../../base/types';

/**
 * Files at or below this size are not worth minifying - the comment/whitespace
 * savings are negligible and the header overhead would dominate. `file_read`
 * skips minification for these and returns raw content.
 */
export const MINIFY_MIN_BYTES = 1024;

/**
 * Whitespace-only normalization applied on every minified read (both the AST and
 * fallback paths): normalize line endings, strip trailing whitespace, and collapse
 * runs of blank lines. Never touches non-whitespace bytes, so it can never change
 * program meaning - the safe worst case is "no reduction."
 */
export function normalizeWhitespace(source: string): string {
  const lines = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''));

  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === '') {
      blankRun++;
      if (blankRun > 1) continue; // collapse consecutive blank lines to one
    } else {
      blankRun = 0;
    }
    collapsed.push(line);
  }

  // Trim leading/trailing blank lines.
  while (collapsed.length && collapsed[0] === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1] === '') collapsed.pop();

  return collapsed.join('\n');
}

/** Rough token estimate (~4 chars/token) used only to report savings, not for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface MinifyResult {
  content: string;
  /** True when comments were stripped via the AST; false when only whitespace was normalized. */
  strippedComments: boolean;
  tokensSaved: number;
}

/**
 * Produce a minified view of `raw`. Tries AST comment-stripping via the injected
 * `codeMinifier` (comments gone) and always finishes with whitespace normalization;
 * if the minifier is absent or declines (unsupported/unparsable language) it falls
 * back to whitespace-only normalization with comments preserved. Never mutates disk.
 */
export async function minifyFileContent(
  raw: string,
  filePath: string,
  codeMinifier?: CodeMinifier
): Promise<MinifyResult> {
  const ext = path.extname(filePath).toLowerCase();
  const stripped = codeMinifier ? await codeMinifier(raw, ext).catch(() => null) : null;
  const content = normalizeWhitespace(stripped ?? raw);
  const tokensSaved = Math.max(0, estimateTokens(raw) - estimateTokens(content));
  return { content, strippedComments: stripped !== null, tokensSaved };
}

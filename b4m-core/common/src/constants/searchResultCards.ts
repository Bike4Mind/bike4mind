/**
 * The fence language the model writes to place image cards inline in a reply.
 *
 * Two families of consumer must agree on this constant:
 *   - WEB_SEARCH_CARDS_PROMPT (@bike4mind/services) teaches the model to emit it, and the reply
 *     renderer (apps/client .../Session/PromptReplies.tsx) intercepts it to render cards instead
 *     of raw text.
 *   - Every other surface that reads reply markdown for an export, download, copy, publish, or
 *     Slack delivery must strip the fenced block entirely with `stripSearchResultCardFences`
 *     below, rather than passing the model-authored card JSON through verbatim. See that
 *     function's own doc comment for the current list of call sites.
 *
 * MUST contain only `\w` characters: both the renderer (`/language-(\w+)/`) and the notebook
 * curation extractor (```` /```(\w+)?/ ````) capture the language with `\w+`, so a hyphen would
 * silently truncate this and the cards would never render or be skipped.
 *
 * MUST already be lowercase: some consumers lowercase the language they capture before
 * comparing, so an uppercase-containing value would pass the `\w`-only rule above while silently
 * breaking that comparison.
 */
export const SEARCH_RESULT_CARDS_LANGUAGE = 'b4m_cards';

// Matches to end of line, or to end of string when the opening fence has no trailing newline yet
// (a generation truncated mid-line) - either way, everything from the match onward is dropped by
// the loop below when no closing fence follows.
const FENCE_OPEN_RE = new RegExp('```' + SEARCH_RESULT_CARDS_LANGUAGE + '\\b[^\\n]*(?:\\n|$)');

/**
 * Removes every ```` ```b4m_cards ... ``` ```` fenced block from reply markdown, so a surface that
 * cannot render cards (export, download, copy, publish, Slack delivery, notebook curation, ...)
 * never shows the user raw model-authored card JSON instead.
 *
 * Handles an unclosed fence (a truncated/streamed reply persisted mid-block) by dropping from the
 * opening fence to end of string, rather than leaving a dangling JSON blob in the output.
 *
 * Consumers (kept here so a new one is easy to spot missing from this list):
 *   - apps/client/pages/api/publish/serve/[...path].ts (public page + ?export=md/html)
 *   - apps/client/app/components/Session/MessageContent.tsx (per-reply Copy button)
 *   - apps/client/app/components/common/DownloadMenu.tsx (Markdown/DOCX/HTML downloads)
 *   - apps/client/app/utils/markdownToStyledHtml.ts (HTML rendering)
 *   - apps/client/app/utils/sessionMarkdownExport.ts (copy session as markdown)
 *   - apps/client/app/utils/sessionExport.ts / bulkNotebookExport.ts (session/notebook export)
 *   - apps/client/app/utils/replyDownloads.ts (per-reply download-as-file menu)
 *   - b4m-core/slack/src/utils/slackMarkdown.ts (Slack message delivery)
 *   - b4m-core/services/src/notebookCurationService/markdownGenerator.ts (curated transcript body)
 *   - apps/client/app/components/Session/PromptReplies.tsx (reply renderer, intercepts to render
 *     cards rather than stripping - not a caller of this function, listed for completeness)
 *   - b4m-core/services/src/notebookCurationService/artifactExtractor.ts (skips the fence rather
 *     than curating raw JSON as a code artifact - not a caller of this function either)
 */
export function stripSearchResultCardFences(markdown: string): string {
  let result = '';
  let rest = markdown;
  for (;;) {
    const openMatch = FENCE_OPEN_RE.exec(rest);
    if (!openMatch) {
      result += rest;
      break;
    }
    result += rest.slice(0, openMatch.index);
    const afterOpen = rest.slice(openMatch.index + openMatch[0].length);
    const closeIndex = afterOpen.indexOf('```');
    if (closeIndex === -1) {
      // Unclosed fence: drop everything from the opening fence to EOF rather than leak a
      // dangling JSON blob from a truncated/streamed reply.
      break;
    }
    rest = afterOpen.slice(closeIndex + 3);
  }
  return result;
}

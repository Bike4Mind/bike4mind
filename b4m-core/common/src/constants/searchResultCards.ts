import { LOCATION_MAP_LANGUAGE, locationMapFallbackMarkdown } from './locationMap';

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

// Anchored to a line start (^ or \n), matching CommonMark's own fenced-code-block rule: an
// opening fence is only recognized at the start of a line (with up to 3 spaces of indent), never
// mid-line. Without this anchor, prose text that merely contains the string "```b4m_cards" - e.g.
// inside an unrelated code sample discussing markdown fences - would be treated as an opening
// fence and everything up to (and past) the next unrelated ``` would be deleted along with it.
// Captures the indent and the backtick run length so the matching close can require the same
// (CommonMark: closing fence must be >= the opening fence's backtick count).
const FENCE_OPEN_RE = new RegExp(
  '(^|\\n)([ \\t]{0,3})(`{3,})(' + SEARCH_RESULT_CARDS_LANGUAGE + '|' + LOCATION_MAP_LANGUAGE + ')\\b[^\\n]*(\\n|$)'
);

/**
 * Removes every ```` ```b4m_cards ... ``` ```` fenced block from reply markdown, so a surface that
 * cannot render cards (export, download, copy, publish, Slack delivery, notebook curation, the
 * CLI, quest export, ...) never shows the user raw model-authored card JSON instead.
 *
 * A ```` ```b4m_map ``` ```` block is rewritten rather than removed: its places become a markdown
 * list with "open in maps" links (locationMapFallbackMarkdown), since the map usually replaces the
 * list the model would otherwise have written in prose.
 *
 * Handles an unclosed fence (a truncated/streamed reply persisted mid-block) by dropping from the
 * opening fence to end of string, rather than leaving a dangling JSON blob in the output.
 *
 * Consumers (kept here so a new one is easy to spot missing from this list):
 *   - apps/client/pages/api/publish/serve/[...path].ts (public page + ?export=md/html)
 *   - apps/client/app/components/Session/MessageContent.tsx (Copy / Download / Publish-and-share)
 *   - apps/client/app/components/common/DownloadMenu.tsx (Markdown/DOCX/HTML downloads)
 *   - apps/client/app/utils/markdownToStyledHtml.ts (HTML rendering)
 *   - apps/client/app/utils/sessionMarkdownExport.ts (copy session as markdown)
 *   - apps/client/app/utils/sessionExport.ts / bulkNotebookExport.ts (session/notebook export)
 *   - apps/client/server/queueHandlers/questExport.ts (quest-plan export ZIP)
 *   - apps/client/server/queueHandlers/slackQuestProcessor.ts (Slack push/desktop notification text)
 *   - b4m-core/slack/src/utils/slackMarkdown.ts (Slack message delivery)
 *   - b4m-core/slack/src/handlers/WorkflowStepHandler.ts (workflow-step output/notification text)
 *   - b4m-core/services/src/notebookCurationService/markdownGenerator.ts (curated transcript body)
 *   - packages/cli/... (terminal rendering of a quest/tool reply)
 *   - apps/client/app/components/Session/PromptReplies.tsx (reply renderer, intercepts to render
 *     cards rather than stripping - not a caller of this function, listed for completeness)
 *   - b4m-core/services/src/notebookCurationService/artifactExtractor.ts (skips the fence rather
 *     than curating raw JSON as a code artifact - not a caller of this function either)
 *   - apps/client/app/utils/replyDownloads.ts (skips the fence by language name rather than
 *     calling this function - not a caller either, listed for completeness)
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
    // Keep the leading newline (or start-of-string) that FENCE_OPEN_RE anchored on - only the
    // fence itself and onward gets dropped.
    const removalStart = openMatch.index + openMatch[1].length;
    result += rest.slice(0, removalStart);
    const fenceLength = openMatch[3].length;
    const afterOpenLine = rest.slice(openMatch.index + openMatch[0].length);
    // Trailing newline is a lookahead, not consumed: only the fence marker itself (and its
    // leading newline) is removed, so a blank line already following the block is preserved -
    // matching how the opening fence's own leading newline is handled above.
    const closeRe = new RegExp('(^|\\n)[ \\t]{0,3}`{' + fenceLength + ',}[ \\t]*(?=\\n|$)');
    const closeMatch = closeRe.exec(afterOpenLine);
    if (!closeMatch) {
      // Unclosed fence: drop everything from the opening fence to EOF rather than leak a
      // dangling JSON blob from a truncated/streamed reply.
      break;
    }
    if (openMatch[4] === LOCATION_MAP_LANGUAGE) {
      result += locationMapFallbackMarkdown(afterOpenLine.slice(0, closeMatch.index));
    }
    rest = afterOpenLine.slice(closeMatch.index + closeMatch[0].length);
  }
  return result;
}

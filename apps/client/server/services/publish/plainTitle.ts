import { parseArtifactsWithFallback } from '@client/app/utils/artifactParser';

// Private-use delimiter for parked code spans; cannot occur in a title that came from chat text.
const CODE_SPAN_MARK = '\uE000';

/**
 * A reply-derived title without its inline markdown markers ("Recap: *Tides*" -> "Recap: Tides").
 * Titles render as plain text (the page <title>, the viewer header, link-preview cards), where the
 * markers would show literally. Not for fabfile titles: a file name's underscores are not emphasis.
 */
export function stripInlineMarkdown(text: string): string {
  // Code span contents are literal, so park them while the emphasis rules run (`a*b*c` keeps its stars).
  const codeSpans: string[] = [];
  const withoutCode = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `${CODE_SPAN_MARK}${codeSpans.length - 1}${CODE_SPAN_MARK}`;
  });

  return (
    withoutCode
      // The URL may hold one level of balanced parentheses: [a](https://x/(y)).
      .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
      .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
      .replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2')
      .replace(new RegExp(`${CODE_SPAN_MARK}(\\d+)${CODE_SPAN_MARK}`, 'g'), (_match, index: string) => {
        return codeSpans[Number(index)] ?? '';
      })
      .trim()
  );
}

export const REPLY_TITLE_MAX = 120;

/** Cut `text` to at most `max` chars at a word boundary, appending an ellipsis when shortened. */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - 3;
  const cut = text.slice(0, room + 1);
  const lastSpace = cut.search(/\s\S*$/);
  const base = lastSpace > room / 2 ? cut.slice(0, lastSpace) : text.slice(0, room);
  return `${base.replace(/[\s.,;:!?-]+$/, '')}...`;
}

/** The first non-empty line of a reply once embedded `<artifact>` blocks are removed. */
export function replyFirstLine(markdown: string): string | undefined {
  return parseArtifactsWithFallback(markdown)
    .cleanedContent.split('\n')
    .map(l => l.trim())
    .find(Boolean);
}

/**
 * The display form of a stored reply title. Strips only a title cut from the reply's first line the
 * way deriveTitle (publish/reply.ts) did before it stripped markers, so pre-fix rows render clean. A
 * caller-supplied title (POST /api/publish/reply `title`, an owner rename via PATCH
 * /api/publish/artifacts/[id]) or an embedded artifact's name is shown verbatim, unless it happens
 * to equal that cut.
 */
export function displayReplyTitle(storedTitle: string, markdown: string): string {
  const line = replyFirstLine(markdown);
  if (!line) return storedTitle;
  const legacyDerived = truncateAtWord(
    line
      .slice(0, REPLY_TITLE_MAX * 4)
      .replace(/^#+\s*/, '')
      .replace(/^[*_>-]+\s*/, ''),
    REPLY_TITLE_MAX
  );
  return storedTitle === legacyDerived ? stripInlineMarkdown(storedTitle) : storedTitle;
}

const OPENER = /<artifact(?=\s)/gi;
const LEADING_WS = /\s+/y;
const CLOSER = /<\/artifact>/gi;
const GT = />/g;
const GT_OR_LINE_TERMINATOR = /[>\n\r\u2028\u2029]/g;

export interface ArtifactTagMatch {
  attrs: string;
  body: string;
}

/**
 * Linear-time equivalent of `/<artifact\s+(.*?)>([\s\S]*?)<\/artifact>/gi` (attrsMayCrossLines
 * false) or `/<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi` (true). Those regexes rescan the rest
 * of the input from every unclosed opener; this caches the next attrs terminator and stops at the
 * first opener with no closer after it, since no later opener can have one.
 */
export function scanArtifactTags(text: string, attrsMayCrossLines: boolean): ArtifactTagMatch[] {
  const stop = attrsMayCrossLines ? GT : GT_OR_LINE_TERMINATOR;
  const out: ArtifactTagMatch[] = [];
  // Position of the first stop char at or after the last lookup; valid for any later attrsStart <= it.
  let termAt = -1;
  OPENER.lastIndex = 0;
  let opener: RegExpExecArray | null;
  while ((opener = OPENER.exec(text)) !== null) {
    LEADING_WS.lastIndex = opener.index + opener[0].length;
    LEADING_WS.exec(text);
    const attrsStart = LEADING_WS.lastIndex;
    if (termAt < attrsStart) {
      stop.lastIndex = attrsStart;
      termAt = stop.exec(text)?.index ?? text.length;
    }
    if (termAt === text.length) break;
    if (text[termAt] !== '>') continue;

    CLOSER.lastIndex = termAt + 1;
    const closer = CLOSER.exec(text);
    if (!closer) break;
    out.push({ attrs: text.slice(attrsStart, termAt), body: text.slice(termAt + 1, closer.index) });
    OPENER.lastIndex = closer.index + closer[0].length;
  }
  return out;
}

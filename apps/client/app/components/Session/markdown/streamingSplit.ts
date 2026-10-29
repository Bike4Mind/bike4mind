export interface StreamingSplit {
  committed: string;
  tail: string;
}

export interface StreamingBlocks {
  blocks: string[];
  tail: string;
}

// CommonMark: an opener may be indented up to 3 spaces and carry an info string (no backtick in it
// for backtick fences); a closer carries nothing and must be at least as long as the opener.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const BLANK = /^[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
// A line still arriving that could still turn into a list item marker.
const PARTIAL_LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)]?)$/;
// A link reference definition resolves references in the block right before it. Footnote
// definitions are left on their own: glued, they would render a footnotes section mid-reply.
const LINK_DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:/;

/**
 * Splits a streaming reply into settled blocks and the live tail. A block ends at a blank line
 * followed by a line that starts a new top-level block; blank lines inside a fence, a `$$` block
 * or a list never end one, so each block parses alone as it will inside the finished reply.
 */
export const splitStreamingBlocks = (text: string): StreamingBlocks => {
  const blocks: string[] = [];
  const rawLines = text.split('\n');
  const lines = rawLines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  let blockStart = 0;
  let offset = 0;
  let fence = '';
  let inMath = false;
  let inList = false;
  // The last element is the line still being typed, so it never ends a block.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const lineEnd = offset + rawLines[i].length + 1;
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = '';
    } else if (inMath) {
      if (line.trim() === '$$') inMath = false;
    } else if (BLANK.test(line)) {
      const next = lines[i + 1];
      const nextComplete = i + 1 < lines.length - 1;
      const continuesList = inList && (LIST_ITEM.test(next) || (!nextComplete && PARTIAL_LIST_ITEM.test(next)));
      if (offset > blockStart && /^\S/.test(next) && !continuesList && !LINK_DEFINITION.test(next)) {
        blocks.push(text.slice(blockStart, lineEnd));
        blockStart = lineEnd;
        inList = false;
      }
    } else {
      const open = FENCE_OPEN.exec(line);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) fence = open[1];
      else if (line.trim() === '$$') inMath = true;
      else inList = LIST_ITEM.test(line) || (inList && /^\s/.test(line));
    }
    offset = lineEnd;
  }
  return { blocks, tail: text.slice(blockStart) };
};

/** The settled blocks joined back together, and the live tail. */
export const splitStreamingMarkdown = (text: string): StreamingSplit => {
  const { blocks, tail } = splitStreamingBlocks(text);
  return { committed: blocks.join(''), tail };
};

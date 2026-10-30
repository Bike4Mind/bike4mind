import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Options } from 'react-markdown';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';

export interface StreamingSplit {
  committed: string;
  tail: string;
}

export interface StreamingBlocks {
  blocks: string[];
  tail: string;
  /** A link reference or footnote definition was seen; those resolve across blocks only in one parse. */
  crossBlock: boolean;
  settledCrossBlock: boolean;
  /** Boundaries in the tail where a node could settle, as of the last parse. */
  settleCandidates: number;
  /** Marker and start of the list the tail ends in (a further item of it is not a boundary), else null. */
  tailListMarker: string | null;
  tailListStart: number;
  /** Offset in the tail of a line a list is waiting on; its end is a reason to parse again. */
  pendingLineAt: number | null;
}

export type BlockParser = (text: string) => BlockNode;

interface BlockNode {
  type: string;
  position?: { start: { offset: number }; end: { offset: number } };
  children?: BlockNode[];
}

/** A parser with the caller's remark plugins, so block boundaries are the ones the renderer sees. */
export const createBlockParser = (remarkPlugins: Options['remarkPlugins']): BlockParser => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkPlugins ?? []);
  return text => processor.parse(text) as BlockNode;
};

const defaultParser = createBlockParser(assistantReplyRemarkPlugins);

const CROSS_BLOCK_TYPES = new Set(['definition', 'footnoteDefinition']);
const hasCrossBlock = (node: BlockNode): boolean =>
  CROSS_BLOCK_TYPES.has(node.type) || !!node.children?.some(hasCrossBlock);

const BLANK_LINE = /\n[ \t]*\n/;
const LIST_ITEM = /^(?:([-*+])|\d{1,9}([.)]))(?:\s|$)/;
const listMarkerAt = (text: string, offset: number) => {
  const m = LIST_ITEM.exec(text.slice(offset, offset + 12));
  return m ? (m[1] ?? m[2]) : null;
};

// A node can only settle at a blank line followed by a column-0 line. While the tail still
// ends in a list, a further item of that list is not a boundary; any other column-0 line ends
// the list first (a lazy continuation counts as ending it, which only costs a parse).
const countSettleCandidates = (text: string, listMarker: string | null, listStart: number) => {
  let count = 0;
  let inList = listMarker !== null;
  let afterBlank = false;
  let lineStart = listStart;
  let first = true;
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    if (/^[ \t]*$/.test(line)) afterBlank = true;
    else {
      if (/^\S/.test(line) && !first) {
        if (afterBlank && (!inList || listMarkerAt(text, lineStart) !== listMarker)) count++;
        if (!afterBlank || !inList || listMarkerAt(text, lineStart) !== listMarker) inList = false;
      }
      afterBlank = false;
    }
    first = false;
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return count;
};

/**
 * Splits a streaming reply into settled blocks and the live tail. A block is one or more whole
 * top-level nodes of the markdown parse. A node settles once a blank line separates it from the
 * next node, at which point later text can no longer change it; a list also waits for the next
 * node's first line to end, since a partial line could still turn into one of its items.
 * `prev` keeps the blocks already settled (so only the tail is parsed) while `text` still starts
 * with them, and the tail is only re-parsed once a new boundary has appeared in it; `final`
 * always parses, so `crossBlock` covers the whole reply.
 */
export const splitStreamingBlocks = (
  text: string,
  parse: BlockParser = defaultParser,
  prev?: StreamingBlocks,
  final = false
): StreamingBlocks => {
  const kept = prev && text.startsWith(prev.blocks.join('')) ? prev : undefined;
  const blocks = kept ? [...kept.blocks] : [];
  let settledCrossBlock = kept?.settledCrossBlock ?? false;
  const tailStart = kept ? kept.blocks.join('').length : 0;
  const tail = text.slice(tailStart);
  if (
    !final &&
    kept &&
    countSettleCandidates(tail, kept.tailListMarker, kept.tailListStart) <= kept.settleCandidates &&
    (kept.pendingLineAt === null || tail.indexOf('\n', kept.pendingLineAt) === -1)
  ) {
    return { ...kept, blocks, tail };
  }

  const nodes = parse(tail).children ?? [];
  let blockStart = 0;
  let settledNodes = 0;
  let pendingLineAt: number | null = null;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const node = nodes[i];
    const next = nodes[i + 1];
    if (!node.position || !next.position) continue;
    const gap = tail.slice(node.position.end.offset, next.position.start.offset);
    const nextLineComplete = tail.indexOf('\n', next.position.start.offset) !== -1;
    if (!BLANK_LINE.test(gap)) continue;
    if (node.type === 'list' && !nextLineComplete) {
      pendingLineAt = next.position.start.offset;
      continue;
    }
    // The node's offset sits after its indentation; the cut goes at the line start so the
    // indentation stays with the node it belongs to.
    const cut = tail.lastIndexOf('\n', next.position.start.offset - 1) + 1;
    blocks.push(tail.slice(blockStart, cut));
    blockStart = cut;
    settledCrossBlock = settledCrossBlock || nodes.slice(settledNodes, i + 1).some(hasCrossBlock);
    settledNodes = i + 1;
  }
  const rest = tail.slice(blockStart);
  const last = nodes[nodes.length - 1];
  const tailListStart = last?.type === 'list' && last.position ? last.position.start.offset - blockStart : 0;
  const tailListMarker = last?.type === 'list' ? listMarkerAt(rest, tailListStart) : null;
  return {
    blocks,
    tail: rest,
    crossBlock: settledCrossBlock || nodes.slice(settledNodes).some(hasCrossBlock),
    settledCrossBlock,
    settleCandidates: countSettleCandidates(rest, tailListMarker, tailListStart),
    tailListMarker,
    tailListStart,
    pendingLineAt: pendingLineAt === null ? null : pendingLineAt - blockStart,
  };
};

/** The settled blocks joined back together, and the live tail. */
export const splitStreamingMarkdown = (text: string): StreamingSplit => {
  const { blocks, tail } = splitStreamingBlocks(text);
  return { committed: blocks.join(''), tail };
};

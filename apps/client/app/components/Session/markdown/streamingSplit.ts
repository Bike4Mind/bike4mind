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
  /** The list the tail ends in, if any: where it starts, its marker and its last item's content indent. */
  tailList: { start: number; marker: string; contentIndent: number } | null;
  /** Offset in the tail of a line a list is waiting on; its end is a reason to parse again. */
  pendingLineAt: number | null;
}

export type BlockParser = (text: string) => BlockNode;

interface BlockNode {
  type: string;
  position?: { start: { offset: number; column: number }; end: { offset: number } };
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
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const markerOf = (line: string) => {
  const m = LIST_ITEM.exec(line);
  return m && !THEMATIC_BREAK.test(line) ? (m[1] ?? m[2]) : null;
};
const indentOf = (line: string) => {
  let indent = 0;
  for (const ch of line) {
    if (ch === ' ') indent++;
    else if (ch === '\t') indent += 4 - (indent % 4);
    else break;
  }
  return indent;
};

/**
 * Counts the places in the tail where a node could settle: a non-blank line after a blank line
 * that starts a new top-level node. While the tail still ends in a list (as of the last parse),
 * a line that continues it is not one: a further item with the same marker, or a line indented
 * to the item's content. Any other line ends the list first. The count only grows as text
 * arrives, so the tail is re-parsed when it rises.
 */
export const countSettleCandidates = (text: string, list: StreamingBlocks['tailList']) => {
  let count = 0;
  let inList = list !== null;
  let afterBlank = false;
  let lineStart = list ? list.start : 0;
  let first = list !== null;
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    // The unterminated last line can still change class (a `1` becoming `1.`), which would let
    // the count drop; inside a list it is left to the list's own wait for that line to end.
    if (lineEnd === -1 && inList && !first) break;
    if (/^[ \t]*$/.test(line)) afterBlank = true;
    else if (first) {
      first = false;
      afterBlank = false;
    } else {
      const indent = indentOf(line);
      const continuesItem = inList && indent >= 1 && indent >= (list?.contentIndent ?? 0);
      const furtherItem = inList && indent === 0 && markerOf(line) === list?.marker;
      if (!continuesItem && !furtherItem) {
        if (afterBlank) count++;
        inList = false;
      }
      afterBlank = false;
    }
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
 * with them, and the tail is only re-parsed once a new boundary has appeared in it or the line
 * a list waits on has ended; `final` always parses, so `crossBlock` covers the whole reply.
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
    countSettleCandidates(tail, kept.tailList) <= kept.settleCandidates &&
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
  let tailList: StreamingBlocks['tailList'] = null;
  if (last?.type === 'list' && last.position) {
    const start = last.position.start.offset - blockStart;
    const lineEnd = rest.indexOf('\n', start);
    const marker = markerOf(rest.slice(start, lineEnd === -1 ? undefined : lineEnd));
    const item = last.children?.[last.children.length - 1];
    const content = item?.children?.[0];
    // An item still without content may be the tail's last line turning into something else.
    if (item?.position && !content && rest.indexOf('\n', item.position.start.offset - blockStart) === -1) {
      pendingLineAt = item.position.start.offset;
    }
    const contentIndent = content?.position ? content.position.start.column - 1 : (marker?.length ?? 1) + 1;
    if (marker) tailList = { start, marker, contentIndent };
  }
  return {
    blocks,
    tail: rest,
    crossBlock: settledCrossBlock || nodes.slice(settledNodes).some(hasCrossBlock),
    settledCrossBlock,
    settleCandidates: countSettleCandidates(rest, tailList),
    tailList,
    pendingLineAt: pendingLineAt === null ? null : pendingLineAt - blockStart,
  };
};

/** The settled blocks joined back together, and the live tail. */
export const splitStreamingMarkdown = (text: string): StreamingSplit => {
  const { blocks, tail } = splitStreamingBlocks(text);
  return { committed: blocks.join(''), tail };
};

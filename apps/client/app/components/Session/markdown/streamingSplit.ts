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
  tailEndsInList: boolean;
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
// A node can only settle at a blank line followed by a column-0 line; while the tail ends in a
// list, a further item is not a boundary. Indented lines (list continuations, code inside an
// item) never are.
const BOUNDARY = /\n[ \t]*\n(?=\S)/g;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const countSettleCandidates = (text: string, endsInList: boolean) => {
  let count = 0;
  for (const match of text.matchAll(BOUNDARY)) {
    const lineStart = match.index + match[0].length;
    if (!endsInList || !LIST_ITEM.test(text.slice(lineStart, lineStart + 12))) count++;
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
  if (!final && kept && countSettleCandidates(tail, kept.tailEndsInList) <= kept.settleCandidates) {
    return { ...kept, blocks, tail, crossBlock: settledCrossBlock };
  }

  const nodes = parse(tail).children ?? [];
  let blockStart = 0;
  let settledNodes = 0;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const node = nodes[i];
    const next = nodes[i + 1];
    if (!node.position || !next.position) continue;
    const gap = tail.slice(node.position.end.offset, next.position.start.offset);
    const nextLineComplete = tail.indexOf('\n', next.position.start.offset) !== -1;
    if (!BLANK_LINE.test(gap) || (node.type === 'list' && !nextLineComplete)) continue;
    // The node's offset sits after its indentation; the cut goes at the line start so the
    // indentation stays with the node it belongs to.
    const cut = tail.lastIndexOf('\n', next.position.start.offset - 1) + 1;
    blocks.push(tail.slice(blockStart, cut));
    blockStart = cut;
    settledCrossBlock = settledCrossBlock || nodes.slice(settledNodes, i + 1).some(hasCrossBlock);
    settledNodes = i + 1;
  }
  const rest = tail.slice(blockStart);
  const tailEndsInList = nodes[nodes.length - 1]?.type === 'list';
  return {
    blocks,
    tail: rest,
    crossBlock: settledCrossBlock || nodes.slice(settledNodes).some(hasCrossBlock),
    settledCrossBlock,
    settleCandidates: countSettleCandidates(rest, tailEndsInList),
    tailEndsInList,
  };
};

/** The settled blocks joined back together, and the live tail. */
export const splitStreamingMarkdown = (text: string): StreamingSplit => {
  const { blocks, tail } = splitStreamingBlocks(text);
  return { committed: blocks.join(''), tail };
};

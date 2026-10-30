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

/**
 * Splits a streaming reply into settled blocks and the live tail. A block is one or more whole
 * top-level nodes of the markdown parse. A node settles once a blank line separates it from the
 * next node, at which point later text can no longer change it; a list also waits for the next
 * node's first line to end, since a partial line could still turn into one of its items.
 * `prev` keeps the blocks already settled (so only the tail is parsed) while `text` still starts
 * with them.
 */
export const splitStreamingBlocks = (
  text: string,
  parse: BlockParser = defaultParser,
  prev?: StreamingBlocks
): StreamingBlocks => {
  const kept = prev && text.startsWith(prev.blocks.join('')) ? prev : undefined;
  const blocks = kept ? [...kept.blocks] : [];
  let settledCrossBlock = kept?.settledCrossBlock ?? false;
  const tailStart = kept ? kept.blocks.join('').length : 0;
  const tail = text.slice(tailStart);

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
    blocks.push(tail.slice(blockStart, next.position.start.offset));
    blockStart = next.position.start.offset;
    settledCrossBlock = settledCrossBlock || nodes.slice(settledNodes, i + 1).some(hasCrossBlock);
    settledNodes = i + 1;
  }
  return {
    blocks,
    tail: tail.slice(blockStart),
    crossBlock: settledCrossBlock || nodes.slice(settledNodes).some(hasCrossBlock),
    settledCrossBlock,
  };
};

/** The settled blocks joined back together, and the live tail. */
export const splitStreamingMarkdown = (text: string): StreamingSplit => {
  const { blocks, tail } = splitStreamingBlocks(text);
  return { committed: blocks.join(''), tail };
};

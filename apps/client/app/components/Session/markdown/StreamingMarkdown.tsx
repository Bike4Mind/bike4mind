import React, { memo, useMemo, useState } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import { createBlockParser, splitStreamingBlocks, type StreamingBlocks } from './streamingSplit';

export interface StreamingMarkdownProps {
  text: string;
  streaming: boolean;
  components: Components;
  remarkPlugins: Options['remarkPlugins'];
  rehypePlugins: Options['rehypePlugins'];
  remarkRehypeOptions: Options['remarkRehypeOptions'];
}

type BlockProps = Omit<StreamingMarkdownProps, 'streaming'> & { lineOffset: number };

interface PositionedNode {
  position?: { start: { line: number }; end: { line: number } };
  children?: PositionedNode[];
}

// A block parses on its own, so its node lines are shifted back to reply-relative ones for the
// components that key on them (the code block artifact ids in PromptReplies).
const offsetLines = (lines: number) => () => (tree: unknown) => {
  const visit = (node: PositionedNode) => {
    if (node.position) {
      node.position.start.line += lines;
      node.position.end.line += lines;
    }
    node.children?.forEach(visit);
  };
  visit(tree as PositionedNode);
};

// Settled blocks skip re-parsing while the tail grows; this only holds while every
// non-text prop keeps its identity across frames.
const MarkdownBlock = memo(function MarkdownBlock({ text, lineOffset, remarkPlugins, ...options }: BlockProps) {
  const plugins = useMemo<Options['remarkPlugins']>(
    () => (lineOffset ? [...(remarkPlugins ?? []), offsetLines(lineOffset)] : remarkPlugins),
    [remarkPlugins, lineOffset]
  );
  return (
    <ReactMarkdown remarkPlugins={plugins} {...options}>
      {text}
    </ReactMarkdown>
  );
});

const countLines = (text: string) => text.split('\n').length - 1;

interface SplitState {
  text: string;
  streaming: boolean;
  streamedHere: boolean;
  split: StreamingBlocks | null;
  crossBlock: boolean;
}

const INITIAL: SplitState = { text: '', streaming: false, streamedHere: false, split: null, crossBlock: false };

/**
 * Renders a reply's markdown. While streaming, each settled block and the live tail parse
 * separately and render as siblings keyed by block index, so a block keeps its React identity
 * (and any per-block state) when it settles. A reply that streamed here keeps that structure
 * once complete. A link reference or footnote definition only resolves across blocks in one
 * parse, so from the frame one is seen the reply is one parse for as long as it only grows,
 * which leaves at most one switch between the two structures. A reply mounted complete is
 * always one parse.
 */
export const StreamingMarkdown = ({ text, streaming, ...options }: StreamingMarkdownProps) => {
  const parse = useMemo(() => createBlockParser(options.remarkPlugins), [options.remarkPlugins]);
  // Derived from the previous frame during render, so settled blocks (and their keys) carry over.
  const [state, setState] = useState<SplitState>(INITIAL);
  let current = state;
  if (state.text !== text || state.streaming !== streaming) {
    const streamedHere = state.streamedHere || streaming;
    let crossBlock = state.crossBlock && text.startsWith(state.text);
    let split: StreamingBlocks | null = null;
    if (!crossBlock && (streaming || streamedHere)) {
      split = splitStreamingBlocks(text, parse, state.split ?? undefined, !streaming);
      if (split.crossBlock) {
        crossBlock = true;
        split = null;
      }
    }
    current = { text, streaming, streamedHere, split, crossBlock };
    setState(current);
  }

  // `blocks` keeps its identity on frames that settle nothing, so the line counts are not redone.
  const blocks = current.split?.blocks;
  const lineOffsets = useMemo(() => {
    const offsets = [0];
    for (const block of blocks ?? []) offsets.push(offsets[offsets.length - 1] + countLines(block));
    return offsets;
  }, [blocks]);

  if (!current.split || !blocks) return <MarkdownBlock key={0} text={text} lineOffset={0} {...options} />;
  const { tail } = current.split;
  const parts = tail ? [...blocks, tail] : blocks;

  // The newline between siblings is what a single parse emits between its top-level nodes.
  return (
    <>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && '\n'}
          <MarkdownBlock text={part} lineOffset={lineOffsets[i]} {...options} />
        </React.Fragment>
      ))}
    </>
  );
};

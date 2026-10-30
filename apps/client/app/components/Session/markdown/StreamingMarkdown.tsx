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
}

const INITIAL: SplitState = { text: '', streaming: false, streamedHere: false, split: null };

/**
 * Renders a reply's markdown. While streaming, each settled block and the live tail parse
 * separately and render as siblings keyed by block index, so a block keeps its React identity
 * (and any per-block state) when it settles. A reply that streamed here keeps that structure
 * once complete, unless it holds a definition that only one parse can resolve across blocks; a
 * reply mounted complete is always one parse.
 */
export const StreamingMarkdown = ({ text, streaming, ...options }: StreamingMarkdownProps) => {
  const parse = useMemo(() => createBlockParser(options.remarkPlugins), [options.remarkPlugins]);
  // Derived from the previous frame during render, so settled blocks (and their keys) carry over.
  const [state, setState] = useState<SplitState>(INITIAL);
  let current = state;
  if (state.text !== text || state.streaming !== streaming) {
    const streamedHere = state.streamedHere || streaming;
    let split: StreamingBlocks | null = null;
    if (streaming || streamedHere) {
      split = splitStreamingBlocks(text, parse, state.split ?? undefined, !streaming);
      if (!streaming && split.crossBlock) split = null;
    }
    current = { text, streaming, streamedHere, split };
    setState(current);
  }

  const parts = useMemo(() => {
    if (!current.split) return null;
    const { blocks, tail } = current.split;
    const texts = tail ? [...blocks, tail] : blocks;
    const offsets = texts.reduce<number[]>((acc, _, i) => {
      acc.push(i === 0 ? 0 : acc[i - 1] + countLines(texts[i - 1]));
      return acc;
    }, []);
    return texts.map((part, i) => ({ text: part, lineOffset: offsets[i] }));
  }, [current.split]);

  if (!parts) return <MarkdownBlock key={0} text={text} lineOffset={0} {...options} />;

  // The newline between siblings is what a single parse emits between its top-level nodes.
  return (
    <>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && '\n'}
          <MarkdownBlock text={part.text} lineOffset={part.lineOffset} {...options} />
        </React.Fragment>
      ))}
    </>
  );
};

import HighlightedCode from '@client/app/components/common/HighlightedCode';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { remarkGfmNoSingleTilde, promoteInlineLatexDollars } from '@client/app/utils/remarkPlugins';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Box, Typography, IconButton, Tooltip } from '@mui/joy';
import { ContentCopy, Check } from '@mui/icons-material';
import MermaidChart from '../Charts/MermaidChart';
import { locateCitedPassage, blockIntersectsPassage, type PassageRange } from './citedPassage';
import { extractMermaidFence } from '@client/app/utils/mermaidFence';

interface Props {
  content: string;
  /**
   * The passage a citation pointed at, as served (#3038). Blocks overlapping it are marked and the
   * first is scrolled into view. A passage that cannot be located in `content` is rendered as a
   * callout above the document instead of being dropped, so the reader still sees the evidence.
   *
   * Marking is only possible on the markdown render path: a `content` this viewer resolves to a
   * single Mermaid diagram returns the chart before any of that, and has no prose blocks to mark.
   * The passage is still SHOWN in that case, as a callout above the chart - callers that route
   * diagrams elsewhere (KnowledgeViewer does) must render UnmarkedCitedPassage themselves.
   */
  citedPassage?: string;
}

/** Marks a block the citation covers. The scroll target is simply the first one in DOM order. */
const CITED_BLOCK_ATTR = 'data-cited';

type MarkdownNode = { position?: { start: { offset?: number }; end: { offset?: number } } };

/**
 * Attributes for one rendered block, given its source position. Returns `{}` for a block outside
 * the cited range, so a document rendered without an anchor is byte-identical to before.
 */
function citedBlockProps(node: MarkdownNode | undefined, range: PassageRange | null): Record<string, string> {
  if (!range) return {};
  const block = { start: node?.position?.start.offset, end: node?.position?.end.offset };
  return blockIntersectsPassage(block, range) ? { [CITED_BLOCK_ATTR]: 'true' } : {};
}

const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  return (
    <Tooltip title={copied ? 'Copied!' : 'Copy code'} variant="solid" size="sm">
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        onClick={handleCopy}
        sx={{
          position: 'absolute',
          top: '8px',
          right: '8px',
          opacity: 0.7,
          color: 'common.white',
          '&:hover': { opacity: 1, bgcolor: 'rgba(255,255,255,0.1)' },
          zIndex: 1,
        }}
      >
        {copied ? <Check fontSize="small" color="success" /> : <ContentCopy fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
};

/**
 * Shown when the document could not be marked with the cited passage, for either of two reasons -
 * see the `title` each caller passes.
 *
 * Rendering it is the point: dropping the passage silently would leave the reader looking at an
 * unmarked document with no sign that the deep link failed, which is indistinguishable from a
 * citation that never had a passage. Showing the text keeps the evidence in front of them.
 */
export const UnmarkedCitedPassage = ({ passage, title }: { passage: string; title: string }) => (
  <Box
    data-testid="markdown-cited-passage-fallback"
    sx={{
      mb: 2,
      p: 1.5,
      borderLeft: '3px solid',
      borderColor: 'primary.solidBg',
      bgcolor: 'primary.softBg',
      borderRadius: 'sm',
    }}
  >
    <Typography level="body-xs" sx={{ mb: 0.5, fontWeight: 'lg' }}>
      {title}
    </Typography>
    <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
      {passage}
    </Typography>
  </Box>
);

const MarkdownViewer: React.FC<Props> = ({ content, citedPassage }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Offsets are into the string ReactMarkdown actually parses, so the passage has to be located in
  // the PROMOTED source - locating it in `content` would shift every offset by whatever that
  // transform inserted and mark the wrong blocks.
  const promotedContent = useMemo(() => promoteInlineLatexDollars(content), [content]);
  const citedRange = useMemo(
    () => (citedPassage ? locateCitedPassage(promotedContent, citedPassage) : null),
    [promotedContent, citedPassage]
  );

  // True when the passage WAS located in the source but no rendered block carries it - the cited
  // text sits in an element type this viewer does not override, a table cell being the common one.
  // Distinct from "not located at all", and told apart in the copy below, because only the latter
  // means the document drifted; both leave the reader needing to see the passage itself.
  const [nothingMarked, setNothingMarked] = useState(false);

  useEffect(() => {
    if (!citedRange) {
      setNothingMarked(false);
      return;
    }
    const anchor = containerRef.current?.querySelector(`[${CITED_BLOCK_ATTR}]`);
    setNothingMarked(!anchor);
    anchor?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [citedRange, promotedContent]);

  // Check if the content is a direct Mermaid diagram
  const isMermaidDiagram =
    content.trim().startsWith('graph') ||
    content.trim().startsWith('sequenceDiagram') ||
    content.trim().startsWith('classDiagram') ||
    content.trim().startsWith('stateDiagram') ||
    content.trim().startsWith('erDiagram') ||
    content.trim().startsWith('gantt') ||
    content.trim().startsWith('pie') ||
    content.trim().startsWith('mindmap');

  // Check if the content is a Mermaid diagram wrapped in code blocks
  const mermaidBody = extractMermaidFence(content);

  // A diagram has no prose blocks to mark, but the prop's contract is that the reader always gets
  // to SEE the cited passage - so these two early returns still render the callout rather than
  // dropping the anchor silently. Titled as a plain passage, not "no longer found": nothing drifted,
  // this document just is not markable.
  const mermaidCitedFallback = citedPassage ? (
    <UnmarkedCitedPassage passage={citedPassage} title="Cited passage" />
  ) : null;

  if (isMermaidDiagram) {
    return (
      <>
        {mermaidCitedFallback}
        <MermaidChart className="markdown-viewer-mermaid" chartDefinition={content} />
      </>
    );
  }

  if (mermaidBody !== null) {
    const chartContent = mermaidBody;
    return (
      <>
        {mermaidCitedFallback}
        <MermaidChart className="markdown-viewer-mermaid" chartDefinition={chartContent} />
      </>
    );
  }

  return (
    <Box
      ref={containerRef}
      className="markdown-viewer-container"
      sx={{
        p: 2,
        width: '100%',
        maxWidth: '100%',
        overflowX: 'hidden',
        '& pre': {
          maxWidth: '100%',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
        // The boundary mark. A rule down the side plus a tint reads as "this is the cited extent"
        // across several blocks, which a background alone does not - a reader checking a claim
        // needs to see where the passage ENDS, not just that something here is relevant.
        [`& [${CITED_BLOCK_ATTR}]`]: {
          borderLeft: '3px solid',
          borderColor: 'primary.solidBg',
          bgcolor: 'primary.softBg',
          borderRadius: 'sm',
          pl: 1.5,
          pr: 1,
          py: 0.5,
          mx: -1.5,
        },
        // A passage covering a loose list marks both the `li` and the `p` inside it, and a nested
        // list marks both levels of `li`. One extent should read as one box, so the inner marks
        // inherit the outer one's tint instead of stacking their own rule and background.
        [`& [${CITED_BLOCK_ATTR}] [${CITED_BLOCK_ATTR}]`]: {
          border: 'none',
          bgcolor: 'transparent',
          borderRadius: 0,
          p: 0,
          mx: 0,
        },
      }}
    >
      {citedPassage && (!citedRange || nothingMarked) && (
        <UnmarkedCitedPassage
          passage={citedPassage}
          title={citedRange ? 'Cited passage' : 'Cited passage (no longer found in this document)'}
        />
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfmNoSingleTilde, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code({ node, className, children, ref, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const language = match?.[1];

            const inline =
              node?.position?.start.line === node?.position?.end.line &&
              node?.position?.start.column !== node?.position?.end.column;

            if (language === 'mermaid') {
              const chartContent = String(children).replace(/\n$/, '').trim();
              return <MermaidChart className="markdown-viewer-mermaid" chartDefinition={chartContent} />;
            }

            return !inline && match ? (
              <Box
                className="markdown-viewer-code-block"
                sx={{ maxWidth: '100%', overflowX: 'auto', position: 'relative' }}
                {...citedBlockProps(node, citedRange)}
              >
                <CopyButton text={String(children).replace(/\n$/, '')} />
                <HighlightedCode
                  code={String(children).replace(/\n$/, '')}
                  language={language}
                  customStyle={{ maxWidth: '100%', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                />
              </Box>
            ) : (
              <code
                {...props}
                className={`markdown-viewer-inline-code ${className || ''}`}
                style={{ wordBreak: 'break-word' }}
              >
                {children}
              </code>
            );
          },
          // These two exist only to carry the cited-block attribute, so they must pass the props
          // react-markdown computed through untouched - `className="task-list-item"` on a GFM
          // checkbox item, `value` on an ordered item - or adding the anchor would quietly strip
          // markup the default renderer produced.
          li: ({ node, children, ...props }) => (
            <li {...props} {...citedBlockProps(node, citedRange)}>
              {children}
            </li>
          ),
          blockquote: ({ node, children, ...props }) => (
            <blockquote {...props} {...citedBlockProps(node, citedRange)}>
              {children}
            </blockquote>
          ),
          p: ({ node, children }) => (
            <Typography component="p" level="body-md" sx={{ mb: 2 }} {...citedBlockProps(node, citedRange)}>
              {children}
            </Typography>
          ),
          h1: ({ node, children }) => (
            <Typography component="h1" level="h1" sx={{ mb: 2 }} {...citedBlockProps(node, citedRange)}>
              {children}
            </Typography>
          ),
          h2: ({ node, children }) => (
            <Typography component="h2" level="h2" sx={{ mb: 2 }} {...citedBlockProps(node, citedRange)}>
              {children}
            </Typography>
          ),
          h3: ({ node, children }) => (
            <Typography component="h3" level="h3" sx={{ mb: 2 }} {...citedBlockProps(node, citedRange)}>
              {children}
            </Typography>
          ),
          h4: ({ node, children }) => (
            <Typography component="h4" level="title-lg" sx={{ mb: 2 }} {...citedBlockProps(node, citedRange)}>
              {children}
            </Typography>
          ),
          h5: ({ node, children }) => (
            <Typography component="h5" level="title-md" sx={{ mb: 2 }} {...citedBlockProps(node, citedRange)}>
              {children}
            </Typography>
          ),
          h6: ({ node, children }) => (
            <Typography component="h6" level="title-sm" sx={{ mb: 2 }} {...citedBlockProps(node, citedRange)}>
              {children}
            </Typography>
          ),
        }}
      >
        {promotedContent}
      </ReactMarkdown>
    </Box>
  );
};

export default MarkdownViewer;

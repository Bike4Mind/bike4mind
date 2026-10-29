import { useId } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { Box } from '@mui/joy';
import { link } from '@client/app/components/Session/MarkdownLink';
import { promoteInlineLatexDollars, remarkGfmNoSingleTilde } from '@client/app/utils/remarkPlugins';

/** Renders model output the way chat does, without raw HTML (react-markdown never emits it). */
export function ArenaMarkdown({ text }: { text: string }) {
  // Footnote ids are page-global; the prompt and both answers share a page.
  const footnotePrefix = `arena-${useId().replace(/:/g, '')}-`;
  return (
    <Box sx={{ overflowWrap: 'anywhere', '& pre': { overflowX: 'auto' }, '& img': { maxWidth: '100%' } }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfmNoSingleTilde, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
        components={{ a: link }}
        remarkRehypeOptions={{ clobberPrefix: footnotePrefix }}
      >
        {promoteInlineLatexDollars(text)}
      </ReactMarkdown>
    </Box>
  );
}

import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { Box } from '@mui/joy';
import { promoteInlineLatexDollars, remarkGfmNoSingleTilde } from '@client/app/utils/remarkPlugins';

/** Renders model output the way chat does, without raw HTML (react-markdown never emits it). */
export function ArenaMarkdown({ text }: { text: string }) {
  return (
    <Box sx={{ overflowWrap: 'anywhere', '& pre': { overflowX: 'auto' }, '& img': { maxWidth: '100%' } }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfmNoSingleTilde, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
      >
        {promoteInlineLatexDollars(text)}
      </ReactMarkdown>
    </Box>
  );
}

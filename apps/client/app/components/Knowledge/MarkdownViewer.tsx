import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { remarkGfmNoSingleTilde, promoteInlineLatexDollars } from '@client/app/utils/remarkPlugins';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Box, Typography, IconButton, Tooltip } from '@mui/joy';
import { ContentCopy, Check } from '@mui/icons-material';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import MermaidChart from '../Charts/MermaidChart';

interface Props {
  content: string;
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

const MarkdownViewer: React.FC<Props> = ({ content }) => {
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
  const mermaidMatch = content.match(/```mermaid\s*([\s\S]*?)```/);

  if (isMermaidDiagram) {
    return <MermaidChart className="markdown-viewer-mermaid" chartDefinition={content} />;
  }

  if (mermaidMatch) {
    const chartContent = mermaidMatch[1].trim();
    return <MermaidChart className="markdown-viewer-mermaid" chartDefinition={chartContent} />;
  }

  return (
    <Box
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
      }}
    >
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
              >
                <CopyButton text={String(children).replace(/\n$/, '')} />
                <SyntaxHighlighter
                  {...props}
                  style={oneDark}
                  language={language}
                  PreTag="div"
                  customStyle={{
                    maxWidth: '100%',
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
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
          p: ({ children }) => (
            <Typography component="p" level="body-md" sx={{ mb: 2 }}>
              {children}
            </Typography>
          ),
          h1: ({ children }) => (
            <Typography component="h1" level="h1" sx={{ mb: 2 }}>
              {children}
            </Typography>
          ),
          h2: ({ children }) => (
            <Typography component="h2" level="h2" sx={{ mb: 2 }}>
              {children}
            </Typography>
          ),
          h3: ({ children }) => (
            <Typography component="h3" level="h3" sx={{ mb: 2 }}>
              {children}
            </Typography>
          ),
          h4: ({ children }) => (
            <Typography component="h4" level="title-lg" sx={{ mb: 2 }}>
              {children}
            </Typography>
          ),
          h5: ({ children }) => (
            <Typography component="h5" level="title-md" sx={{ mb: 2 }}>
              {children}
            </Typography>
          ),
          h6: ({ children }) => (
            <Typography component="h6" level="title-sm" sx={{ mb: 2 }}>
              {children}
            </Typography>
          ),
        }}
      >
        {promoteInlineLatexDollars(content)}
      </ReactMarkdown>
    </Box>
  );
};

export default MarkdownViewer;

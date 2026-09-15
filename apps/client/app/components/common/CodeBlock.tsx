import React, { useRef, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/joy';
import { ContentCopy, Check } from '@mui/icons-material';

interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  children?: React.ReactNode;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ children, ...props }) => {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (preRef.current) {
      // Use textContent as fallback for testing environments (JSDOM) where innerText might be empty
      const text = preRef.current.innerText || preRef.current.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy text: ', err);
      }
    }
  };

  return (
    <Box
      sx={{
        position: 'relative',
        mb: 2,
        borderRadius: '8px',
        overflow: 'hidden',
      }}
      className="code-block-wrapper"
    >
      <pre
        ref={preRef}
        {...props}
        style={{
          margin: 0,
          // Ensure the pre tag takes up the full width so the button is positioned correctly
          width: '100%',
          ...props.style,
        }}
      >
        {children}
      </pre>
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
            bgcolor: 'var(--joy-palette-background-level1)',
            backdropFilter: 'blur(4px)',
            transition: 'opacity 0.2s',
            '&:hover': {
              opacity: 1,
              bgcolor: 'var(--joy-palette-background-level2)',
            },
            zIndex: 1,
          }}
        >
          {copied ? <Check fontSize="small" color="success" /> : <ContentCopy fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Box>
  );
};

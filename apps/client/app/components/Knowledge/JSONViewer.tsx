import React from 'react';
import { Box, Typography } from '@mui/joy';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface JSONViewerProps {
  content: string;
}

const JSONViewer: React.FC<JSONViewerProps> = ({ content }) => {
  let formatted = '';
  let error = null;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <Box className="json-viewer-container" sx={{ padding: 2, overflowY: 'auto', height: '100%' }}>
      {error ? (
        <Typography className="json-viewer-error" color="danger">
          Invalid JSON: {error}
        </Typography>
      ) : (
        <SyntaxHighlighter
          className="json-viewer-content"
          language="json"
          style={oneDark}
          customStyle={{ margin: 0, borderRadius: '4px', minHeight: '100%' }}
        >
          {formatted}
        </SyntaxHighlighter>
      )}
    </Box>
  );
};

export default JSONViewer;

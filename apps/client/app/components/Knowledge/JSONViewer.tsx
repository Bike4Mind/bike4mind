import HighlightedCode from '@client/app/components/common/HighlightedCode';
import React from 'react';
import { Box, Typography } from '@mui/joy';

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
        <HighlightedCode
          className="json-viewer-content"
          code={formatted}
          language="json"
          customStyle={{ minHeight: '100%' }}
        />
      )}
    </Box>
  );
};

export default JSONViewer;

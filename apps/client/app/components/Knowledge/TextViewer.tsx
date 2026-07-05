import React from 'react';
import { Box, Typography } from '@mui/joy';

interface TextViewerProps {
  content: string;
}

const TextViewer: React.FC<TextViewerProps> = ({ content }) => {
  return (
    <Box className="text-viewer-container" sx={{ padding: 2 }}>
      <Typography
        className="text-viewer-content"
        component="pre"
        sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {content}
      </Typography>
    </Box>
  );
};

export default TextViewer;

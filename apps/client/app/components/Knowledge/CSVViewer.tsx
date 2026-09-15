import React from 'react';
import { Box } from '@mui/joy';
import GrokTable from './GrokTable';

interface CSVViewerProps {
  content: string;
}

const CSVViewer: React.FC<CSVViewerProps> = ({ content }) => {
  return (
    <Box className="csv-viewer-container" sx={{ padding: 2, overflowY: 'auto', height: '100%' }}>
      <GrokTable csvContent={content} />
    </Box>
  );
};

export default CSVViewer;

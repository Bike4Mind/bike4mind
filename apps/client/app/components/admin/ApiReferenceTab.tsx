import { Box, Button, Divider, Sheet, Typography } from '@mui/joy';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState } from 'react';
import { API_REFERENCE_CONTENT } from './content/apiReferenceContent';
import { QUICKSTART_CONTENT } from './content/quickstartContent';

const markdownStyles = {
  '& h1': { fontSize: '1.8rem', fontWeight: 700, mt: 3, mb: 2 },
  '& h2': { fontSize: '1.4rem', fontWeight: 600, mt: 2.5, mb: 1.5 },
  '& h3': { fontSize: '1.15rem', fontWeight: 600, mt: 2, mb: 1 },
  '& p': { mb: 1.5, lineHeight: 1.7 },
  '& ul, & ol': { pl: 3, mb: 1.5 },
  '& li': { mb: 0.5 },
  '& code': {
    px: 0.75,
    py: 0.25,
    borderRadius: 'sm',
    fontSize: '0.85em',
    bgcolor: 'neutral.100',
  },
  '& pre': {
    p: 2,
    borderRadius: 'md',
    overflow: 'auto',
    bgcolor: 'neutral.900',
    color: 'neutral.50',
    mb: 2,
    '& code': {
      bgcolor: 'transparent',
      color: 'inherit',
      p: 0,
    },
  },
  '& table': {
    width: '100%',
    borderCollapse: 'collapse',
    mb: 2,
    '& th, & td': {
      border: '1px solid',
      borderColor: 'neutral.300',
      px: 1.5,
      py: 1,
      textAlign: 'left',
      fontSize: '0.875rem',
    },
    '& th': {
      bgcolor: 'neutral.100',
      fontWeight: 600,
    },
  },
  '& hr': {
    my: 3,
    borderColor: 'neutral.200',
  },
  '& strong': {
    fontWeight: 600,
  },
};

const ApiReferenceTab = () => {
  const [view, setView] = useState<'full' | 'quickstart'>('full');

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography level="h3">API Reference</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button
            component="a"
            href="/api/v1/docs"
            target="_blank"
            rel="noopener noreferrer"
            variant="outlined"
            color="neutral"
            size="sm"
            data-testid="api-reference-open-docs-btn"
          >
            Interactive Docs
          </Button>
          <Button
            component="a"
            href="/api/v1/openapi.json"
            // Same-origin, so the browser saves rather than navigates.
            download="openapi.json"
            variant="outlined"
            color="neutral"
            size="sm"
            data-testid="api-reference-download-spec-btn"
          >
            Download OpenAPI Spec
          </Button>
          <Divider orientation="vertical" />
          <Sheet
            variant={view === 'full' ? 'solid' : 'outlined'}
            color={view === 'full' ? 'primary' : 'neutral'}
            sx={{
              px: 2,
              py: 0.75,
              borderRadius: 'md',
              cursor: 'pointer',
              fontWeight: view === 'full' ? 600 : 400,
              fontSize: '0.875rem',
            }}
            onClick={() => setView('full')}
          >
            Full API Reference
          </Sheet>
          <Sheet
            variant={view === 'quickstart' ? 'solid' : 'outlined'}
            color={view === 'quickstart' ? 'primary' : 'neutral'}
            sx={{
              px: 2,
              py: 0.75,
              borderRadius: 'md',
              cursor: 'pointer',
              fontWeight: view === 'quickstart' ? 600 : 400,
              fontSize: '0.875rem',
            }}
            onClick={() => setView('quickstart')}
          >
            Claude Code Quickstart
          </Sheet>
        </Box>
      </Box>
      <Sheet variant="outlined" sx={{ p: 3, borderRadius: 'lg', ...markdownStyles }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {view === 'full' ? API_REFERENCE_CONTENT : QUICKSTART_CONTENT}
        </ReactMarkdown>
      </Sheet>
    </Box>
  );
};

export default ApiReferenceTab;

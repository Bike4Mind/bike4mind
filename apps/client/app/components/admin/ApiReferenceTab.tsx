import { Alert, Box, Button, Divider, Link, Sheet, Typography } from '@mui/joy';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState } from 'react';
import { getApiReferenceContent } from './content/apiReferenceContent';
import { getQuickstartContent } from './content/quickstartContent';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import { useGenericApiKeyScopes } from '@client/app/hooks/useGenericApiKeyScopes';

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
    bgcolor: 'background.level1',
    color: 'text.primary',
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
      borderColor: 'divider',
      px: 1.5,
      py: 1,
      textAlign: 'left',
      fontSize: '0.875rem',
    },
    '& th': {
      bgcolor: 'background.level1',
      color: 'text.primary',
      fontWeight: 600,
    },
  },
  '& hr': {
    my: 3,
    borderColor: 'divider',
  },
  '& strong': {
    fontWeight: 600,
  },
};

type View = 'docs' | 'full' | 'quickstart';

const VIEWS: { value: View; label: string }[] = [
  { value: 'docs', label: 'Interactive Docs' },
  { value: 'full', label: 'Auth & Unmigrated Endpoints' },
  { value: 'quickstart', label: 'Claude Code Quickstart' },
];

const ApiReferenceTab = () => {
  const [view, setView] = useState<View>('docs');
  const scopes = useGenericApiKeyScopes();

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography level="h3">API Reference</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button
            component="a"
            href={ExternalLinks.apiDocs}
            target="_blank"
            rel="noopener noreferrer"
            variant="outlined"
            color="neutral"
            size="sm"
            data-testid="api-reference-open-docs-btn"
          >
            Open in New Tab
          </Button>
          <Button
            component="a"
            href={ExternalLinks.openApiSpec}
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
          {VIEWS.map(({ value, label }) => (
            <Sheet
              key={value}
              variant={view === value ? 'solid' : 'outlined'}
              color={view === value ? 'primary' : 'neutral'}
              sx={{
                px: 2,
                py: 0.75,
                borderRadius: 'md',
                cursor: 'pointer',
                fontWeight: view === value ? 600 : 400,
                fontSize: '0.875rem',
              }}
              onClick={() => setView(value)}
              data-testid={`api-reference-view-${value}-toggle`}
            >
              {label}
            </Sheet>
          ))}
        </Box>
      </Box>
      {view === 'full' && (
        // This reference is hand-maintained (apiReferenceContent.ts) and is not
        // generated from the code, so it can lag reality. Point readers at the
        // generated, drift-gated spec (the Interactive Docs view) for endpoints that
        // have one. Removed as the hand-written surface is migrated onto contracts.
        <Alert color="warning" variant="soft" sx={{ mb: 2 }} data-testid="api-reference-drift-banner">
          <Typography level="body-sm">
            This reference is hand-maintained and may lag the code. Where an endpoint has a contract, the Interactive
            Docs view (
            <Link
              href={ExternalLinks.apiDocs}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="api-reference-drift-docs-link"
            >
              open in a new tab
            </Link>
            ) is authoritative; this page covers the endpoints that do not have one yet.
          </Typography>
        </Alert>
      )}
      {view === 'docs' ? (
        // Same-origin frame of the Scalar page, which ships its own CSP (pages/api/v1/docs.ts).
        // Mounted only while active so its bundle loads on demand.
        <Box
          component="iframe"
          src={ExternalLinks.apiDocs}
          title="API reference"
          data-testid="api-reference-docs-iframe"
          sx={{
            flex: 1,
            minHeight: 480,
            width: '100%',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 'lg',
          }}
        />
      ) : (
        <Sheet variant="outlined" sx={{ p: 3, borderRadius: 'lg', ...markdownStyles }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {view === 'full'
              ? getApiReferenceContent(window.location.origin, scopes)
              : getQuickstartContent(window.location.origin)}
          </ReactMarkdown>
        </Sheet>
      )}
    </Box>
  );
};

export default ApiReferenceTab;

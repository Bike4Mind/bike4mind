import { Alert, Box, Button, Link, Sheet, Stack, ToggleButtonGroup, Typography } from '@mui/joy';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState } from 'react';
import { getApiReferenceContent } from './content/apiReferenceContent';
import { getQuickstartContent } from './content/quickstartContent';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import { useGenericApiKeyScopes } from '@client/app/hooks/useGenericApiKeyScopes';
import { AdminPageHeader } from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

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
  { value: 'docs', label: 'Interactive docs' },
  { value: 'full', label: 'Auth and unmigrated endpoints' },
  { value: 'quickstart', label: 'Claude Code quickstart' },
];

const ApiReferenceTab = () => {
  const [view, setView] = useState<View>('docs');
  const scopes = useGenericApiKeyScopes();

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ height: '100%' }} data-testid="admin-api-reference-tab">
      <AdminPageHeader
        title="API reference"
        description="The public API spec, auth notes for older endpoints and a quickstart."
        actions={
          <>
            <Button
              component="a"
              href={ExternalLinks.apiDocs}
              target="_blank"
              rel="noopener noreferrer"
              variant="outlined"
              color="neutral"
              size="sm"
              data-testid="api-reference-open-docs-btn"
              sx={{ whiteSpace: 'nowrap' }}
            >
              Open in new tab
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
              sx={{ whiteSpace: 'nowrap' }}
            >
              Download OpenAPI spec
            </Button>
          </>
        }
      />
      <ToggleButtonGroup
        size="sm"
        value={view}
        onChange={(_e, v) => v && setView(v as View)}
        aria-label="Reference view"
        sx={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}
      >
        {VIEWS.map(({ value, label }) => (
          <Button
            key={value}
            value={value}
            data-testid={`api-reference-view-${value}-toggle`}
            sx={{ whiteSpace: 'nowrap' }}
          >
            {label}
          </Button>
        ))}
      </ToggleButtonGroup>
      {view === 'full' && (
        // This reference is hand-maintained (apiReferenceContent.ts) and is not
        // generated from the code, so it can lag reality. Point readers at the
        // generated, drift-gated spec (the Interactive docs view) for endpoints that
        // have one. Removed as the hand-written surface is migrated onto contracts.
        <Alert color="warning" variant="soft" data-testid="api-reference-drift-banner">
          <Typography level="body-sm">
            This reference is hand-maintained and may lag the code. Where an endpoint has a contract, the Interactive
            docs view (
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
    </Stack>
  );
};

export default ApiReferenceTab;

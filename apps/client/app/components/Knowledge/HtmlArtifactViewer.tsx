import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Typography, Alert, CircularProgress, Stack } from '@mui/joy';
import { type HtmlArtifact } from '@bike4mind/common';
import { validateArtifactContent } from '@client/app/utils/artifactParser';
import { sanitizeHtmlForIframe, absolutizeBlessedScripts } from '@client/app/utils/htmlSanitizer';
import { whiteAlpha } from '@client/app/utils/themes/colors';
import { Warning as WarningIcon } from '@mui/icons-material';

interface HtmlArtifactViewerProps {
  artifact: HtmlArtifact;
  onError?: (error: string) => void;
}

// Generate sanitized HTML for safe rendering. Delegates to the shared
// sanitizer (see utils/htmlSanitizer.ts). The full-panel viewer opts into
// scripts (`allowScripts`) so interactive artifacts run; the iframe sandbox
// + the /api/artifact-sandbox route CSP are the security boundary.
const generateSanitizedHTML = (htmlContent: string) => {
  const { cleanHtml, isCompleteDocument } = sanitizeHtmlForIframe(absolutizeBlessedScripts(htmlContent), {
    allowScripts: true,
  });

  // Wrap in a complete HTML document if it's not already
  if (isCompleteDocument) {
    return cleanHtml;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HTML Artifact</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      line-height: 1.6;
    }
    * {
      box-sizing: border-box;
    }
  </style>
</head>
<body>
  ${cleanHtml}
</body>
</html>`;
};

const HtmlArtifactViewer: React.FC<HtmlArtifactViewerProps> = ({ artifact, onError }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // loadCount drives iframe key - incrementing it remounts the iframe so the
  // sandbox reloads and accepts fresh content when the artifact changes.
  const [loadCount, setLoadCount] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sanitizedHTMLRef = useRef<string | null>(null);

  const validation = useMemo(() => {
    return validateArtifactContent(artifact.type, artifact.content);
  }, [artifact.content, artifact.type]);

  const sanitizedHTML = useMemo(() => {
    if (!validation.isValid) return null;
    return generateSanitizedHTML(artifact.content);
  }, [artifact.content, validation.isValid]);

  useEffect(() => {
    if (!validation.isValid) {
      const errorMsg = `Invalid HTML artifact: ${validation.errors.join(', ')}`;
      setError(errorMsg);
      onError?.(errorMsg);
    } else {
      setError(null);
    }
  }, [validation.isValid, validation.errors, onError]);

  // When content changes, queue a fresh sandbox load.
  useEffect(() => {
    if (!sanitizedHTML) return;
    sanitizedHTMLRef.current = sanitizedHTML;
    setIsLoading(true);
    setLoadCount(c => c + 1);
  }, [sanitizedHTML]);

  // Listen for the sandbox ready signal, then deliver the artifact HTML.
  // /api/artifact-sandbox carries its own per-route CSP (style-src https:) so
  // HTML artifacts can load CDN stylesheets without widening the global app CSP.
  // The check event.source !== iframeRef.current?.contentWindow ensures only the
  // current iframe's postMessage is accepted (works even without allow-same-origin).
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== 'artifact-sandbox-ready') return;
      if (!sanitizedHTMLRef.current) return;
      iframeRef.current?.contentWindow?.postMessage({ type: 'artifact-html', content: sanitizedHTMLRef.current }, '*');
      setIsLoading(false);
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleError = () => {
    const errorMsg = 'Failed to load HTML content';
    setError(errorMsg);
    onError?.(errorMsg);
    setIsLoading(false);
  };

  // Show error if validation failed - but still display the content
  const hasValidationErrors = !validation.isValid;

  if (error) {
    return (
      <Alert color="danger">
        <Typography level="title-sm">HTML Content Error</Typography>
        <Typography level="body-sm" sx={{ mt: 1 }}>
          {error}
        </Typography>
      </Alert>
    );
  }

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {hasValidationErrors && (
        <Alert
          color="danger"
          sx={{
            m: 2,
            flexShrink: 0,
            bgcolor: 'danger.700',
            borderColor: 'danger.500',
            '& .MuiAlert-startDecorator': { color: 'danger.100' },
          }}
        >
          <Stack spacing={1}>
            <Typography level="title-sm" startDecorator={<WarningIcon />} sx={{ color: 'danger.50' }}>
              Invalid HTML Content
            </Typography>
            <Typography level="body-sm" sx={{ color: 'danger.100' }}>
              {validation.errors.join(', ')}
            </Typography>
            <Typography level="body-xs" sx={{ mt: 1, fontStyle: 'italic', color: 'danger.200' }}>
              The HTML code has validation errors. It may not render correctly.
            </Typography>
          </Stack>
        </Alert>
      )}

      <Box sx={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {isLoading && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: whiteAlpha[0][80],
              zIndex: 1,
            }}
          >
            <CircularProgress size="sm" />
          </Box>
        )}

        {loadCount > 0 && (
          <iframe
            key={loadCount}
            ref={iframeRef}
            src="/api/artifact-sandbox"
            title={artifact.title}
            // Web Audio (AudioContext) is gated by the autoplay Permissions Policy,
            // which defaults to self-only and denies this opaque-origin sandbox iframe.
            // Without this grant, an interactive artifact's "play" button resumes a
            // context that never produces sound.
            allow="autoplay"
            onError={handleError}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              borderRadius: '4px',
            }}
            sandbox="allow-scripts"
          />
        )}
      </Box>
    </Box>
  );
};

export default HtmlArtifactViewer;

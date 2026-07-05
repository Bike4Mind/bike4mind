import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Box, CircularProgress, Typography } from '@mui/joy';
import { type ReactArtifact, type HtmlArtifact, type SvgArtifact } from '@bike4mind/common';
import DOMPurify from 'dompurify';
import { sanitizeHtmlForIframe, absolutizeBlessedScripts } from '@client/app/utils/htmlSanitizer';
import { useReactArtifactSandbox } from '@client/app/hooks/useReactArtifactSandbox';

type ArtifactType = 'react' | 'html' | 'svg';
type ArtifactContent = ReactArtifact | HtmlArtifact | SvgArtifact;

interface InlineArtifactPreviewProps {
  artifact: ArtifactContent;
  type: ArtifactType;
  maxHeight?: number;
  onError?: (error: string) => void;
}

// Generate sanitized HTML. The inline preview renders into the same
// opaque-origin sandbox iframe (/api/artifact-sandbox, sandbox="allow-scripts")
// as the full-panel viewer, so it opts into scripts too; otherwise interactive
// artifacts (charts, computed fields) render inert. The iframe sandbox + the
// route CSP are the security boundary; blessed `/static/...` libs are
// absolutized to the app origin so they resolve from the opaque document.
const generateSanitizedHTML = (htmlContent: string) => {
  const { cleanHtml, isCompleteDocument } = sanitizeHtmlForIframe(absolutizeBlessedScripts(htmlContent), {
    allowScripts: true,
  });

  if (isCompleteDocument) return cleanHtml;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; padding: 8px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    * { box-sizing: border-box; }
  </style>
</head>
<body>${cleanHtml}</body>
</html>`;
};

const generateSanitizedSVG = (svgContent: string) => {
  return DOMPurify.sanitize(svgContent, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ALLOWED_TAGS: [
      'svg',
      'path',
      'circle',
      'rect',
      'line',
      'ellipse',
      'polygon',
      'polyline',
      'g',
      'defs',
      'use',
      'text',
      'tspan',
      'clipPath',
      'mask',
      'filter',
      'linearGradient',
      'radialGradient',
      'stop',
      'animate',
      'animateTransform',
    ],
    ALLOWED_ATTR: [
      'viewBox',
      'xmlns',
      'width',
      'height',
      'fill',
      'stroke',
      'stroke-width',
      'stroke-linecap',
      'stroke-linejoin',
      'd',
      'cx',
      'cy',
      'r',
      'rx',
      'ry',
      'x',
      'y',
      'x1',
      'y1',
      'x2',
      'y2',
      'points',
      'transform',
      'opacity',
      'id',
      'class',
      'style',
    ],
    FORBID_ATTR: ['onclick', 'onload', 'onerror', 'onmouseover', 'xlink:href'],
  });
};

const InlineArtifactPreview: React.FC<InlineArtifactPreviewProps> = ({ artifact, type, maxHeight = 400, onError }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // React artifacts render via the dedicated sandbox route whose per-route CSP carries
  // 'unsafe-eval'; HTML artifacts via /api/artifact-sandbox.
  const reactArtifact = type === 'react' ? (artifact as ReactArtifact) : null;
  const {
    iframeRef: reactIframeRef,
    iframeKey: reactIframeKey,
    src: reactSandboxSrc,
    isLoading: reactPreviewLoading,
    error: reactRuntimeError,
  } = useReactArtifactSandbox(reactArtifact?.content ?? null, reactArtifact?.metadata?.dependencies ?? []);

  // HTML artifacts use /api/artifact-sandbox + postMessage so the per-route
  // CSP (style-src https:) applies instead of the global app policy.
  const htmlIframeRef = useRef<HTMLIFrameElement>(null);
  const [htmlLoadCount, setHtmlLoadCount] = useState(0);
  const htmlContentRef = useRef<string | null>(null);

  const { content: renderedContent, generationError } = useMemo(() => {
    try {
      if (type === 'html') {
        const htmlArtifact = artifact as HtmlArtifact;
        return { content: generateSanitizedHTML(htmlArtifact.content), generationError: null };
      } else if (type === 'svg') {
        const svgArtifact = artifact as SvgArtifact;
        return { content: generateSanitizedSVG(svgArtifact.content), generationError: null };
      }
      return { content: null, generationError: null };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to generate preview';
      return { content: null, generationError: errorMsg };
    }
  }, [artifact, type]);

  useEffect(() => {
    if (generationError) {
      setError(generationError);
      onError?.(generationError);
    }
  }, [generationError, onError]);

  // Surface React sandbox runtime errors to the parent (telemetry); the sandbox also
  // renders the error inline inside the iframe.
  useEffect(() => {
    if (reactRuntimeError) onError?.(reactRuntimeError);
  }, [reactRuntimeError, onError]);

  // HTML artifacts: queue a fresh sandbox load when content changes.
  useEffect(() => {
    if (type !== 'html' || !renderedContent) return;
    htmlContentRef.current = renderedContent;
    setIsLoading(true);
    setHtmlLoadCount(c => c + 1);
  }, [renderedContent, type]);

  // HTML artifact sandbox: listen for ready signal, deliver HTML via postMessage.
  useEffect(() => {
    if (type !== 'html') return;

    const handler = (event: MessageEvent) => {
      if (event.source !== htmlIframeRef.current?.contentWindow) return;
      if (event.data?.type !== 'artifact-sandbox-ready') return;
      if (!htmlContentRef.current) return;
      htmlIframeRef.current?.contentWindow?.postMessage(
        { type: 'artifact-html', content: htmlContentRef.current },
        '*'
      );
      setIsLoading(false);
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [type]);

  const handleIframeError = () => {
    const errorMsg = 'Failed to load preview';
    setError(errorMsg);
    onError?.(errorMsg);
    setIsLoading(false);
  };

  if (error) {
    return (
      <Box
        sx={{
          p: 2,
          bgcolor: 'danger.softBg',
          borderRadius: 'sm',
          border: '1px solid',
          borderColor: 'danger.outlinedBorder',
        }}
      >
        <Typography level="body-sm" sx={{ color: 'danger.plainColor' }}>
          {error}
        </Typography>
      </Box>
    );
  }

  // SVG renders directly without iframe
  if (type === 'svg' && renderedContent) {
    return (
      <Box
        sx={{
          maxHeight,
          overflow: 'auto',
          borderRadius: 'sm',
          bgcolor: 'background.surface',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 1,
        }}
        dangerouslySetInnerHTML={{ __html: renderedContent }}
        data-testid="inline-svg-preview"
      />
    );
  }

  // React and HTML render in iframe
  return (
    <Box
      sx={{
        position: 'relative',
        maxHeight,
        overflow: 'hidden',
        borderRadius: 'sm',
        bgcolor: 'background.surface',
      }}
      data-testid="inline-artifact-preview"
    >
      {(type === 'react' ? reactPreviewLoading : isLoading) && (
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
            bgcolor: 'background.level1',
            zIndex: 1,
          }}
        >
          <CircularProgress size="sm" />
        </Box>
      )}

      {/* React artifacts: dedicated sandbox route whose per-route CSP carries 'unsafe-eval' */}
      {type === 'react' && (
        <iframe
          key={reactIframeKey}
          ref={reactIframeRef}
          src={reactSandboxSrc}
          title={artifact.title}
          // Web Audio (AudioContext) is gated by the autoplay Permissions Policy,
          // which defaults to self-only and denies this opaque-origin sandbox iframe.
          // Without this grant, an artifact's "play" button resumes a context that
          // never actually produces sound.
          allow="autoplay"
          onError={handleIframeError}
          style={{
            width: '100%',
            height: maxHeight,
            border: 'none',
            borderRadius: '4px',
          }}
          sandbox="allow-scripts"
          data-testid="inline-artifact-iframe"
        />
      )}

      {/* HTML artifacts: sandbox route so style-src https: is scoped to /api/artifact-sandbox */}
      {type === 'html' && htmlLoadCount > 0 && (
        <iframe
          key={htmlLoadCount}
          ref={htmlIframeRef}
          src="/api/artifact-sandbox"
          title={artifact.title}
          // See note above: grant autoplay so interactive HTML artifacts using
          // Web Audio can produce sound on a user click.
          allow="autoplay"
          onError={handleIframeError}
          style={{
            width: '100%',
            height: maxHeight,
            border: 'none',
            borderRadius: '4px',
          }}
          sandbox="allow-scripts"
          data-testid="inline-artifact-iframe"
        />
      )}
    </Box>
  );
};

export default InlineArtifactPreview;

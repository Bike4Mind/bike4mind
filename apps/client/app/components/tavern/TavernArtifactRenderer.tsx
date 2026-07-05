import React, { useEffect, useRef, useMemo } from 'react';
import { Box, Typography } from '@mui/joy';
import mermaid from 'mermaid';
import { useTheme } from '@mui/joy';
import type { HeartbeatLogEntry } from '@client/app/types/heartbeatTypes';
import MermaidChart from '../Charts/MermaidChart';
import RechartsChart from '../Charts/RechartsChart';

interface TavernArtifactRendererProps {
  artifact: NonNullable<HeartbeatLogEntry['artifact']>;
  compact?: boolean;
}

/** Compact mermaid preview: title + SVG, no tabs/buttons */
const CompactMermaidPreview: React.FC<{ definition: string; title?: string }> = ({ definition, title }) => {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme.palette.mode === 'dark' ? 'dark' : 'default',
      securityLevel: 'loose',
    });
  }, [theme.palette.mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    const render = async (el: HTMLDivElement) => {
      if (cancelled || el.offsetWidth === 0) return;
      try {
        const { svg } = await mermaid.render(
          'tavern-compact-mermaid-' + Math.random().toString(36).slice(2),
          definition
        );
        if (cancelled) return;
        el.innerHTML = svg;
        const svgEl = el.querySelector('svg');
        if (svgEl) {
          svgEl.setAttribute('width', '100%');
          svgEl.removeAttribute('height');
          svgEl.style.display = 'block';
        }
      } catch {
        // silently fail in compact preview; full modal will show the error
      }
    };

    render(container);

    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0 && !container.querySelector('svg')) {
        render(container);
      }
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [definition, theme.palette.mode]);

  return (
    <Box>
      {title && (
        <Typography sx={{ fontFamily: 'monospace', fontSize: '10px', mb: 0.5 }} level="body-xs">
          {title}
        </Typography>
      )}
      <Box ref={containerRef} sx={{ width: '100%' }} />
    </Box>
  );
};

const TavernArtifactRenderer: React.FC<TavernArtifactRendererProps> = ({ artifact, compact = true }) => {
  const maxHeight = compact ? 200 : undefined;

  const content = useMemo(() => {
    switch (artifact.type) {
      case 'mermaid':
        if (compact) {
          return <CompactMermaidPreview definition={artifact.data} title={artifact.title} />;
        }
        return <MermaidChart chartDefinition={artifact.data} title={artifact.title} readOnly />;

      case 'recharts': {
        let rechartsConfig: ReturnType<typeof JSON.parse> | null = null;
        try {
          rechartsConfig = JSON.parse(artifact.data);
        } catch {
          // invalid JSON, fall through to error display
        }
        if (!rechartsConfig) {
          return (
            <Typography level="body-sm" color="danger">
              Failed to parse chart data
            </Typography>
          );
        }
        return <RechartsChart config={rechartsConfig} title={artifact.title} description={artifact.description} />;
      }

      case 'image':
        return (
          <Box
            component="img"
            src={artifact.data}
            alt={artifact.title || 'Agent-generated image'}
            sx={{ maxWidth: '100%', borderRadius: 'sm' }}
          />
        );

      default:
        return null;
    }
  }, [artifact.type, artifact.data, artifact.title, artifact.description, compact]);

  if (!content) return null;

  return (
    <Box
      data-testid="tavern-artifact-renderer"
      sx={{
        maxHeight,
        overflow: compact ? 'hidden' : 'auto',
        borderRadius: 'sm',
        border: '1px solid',
        borderColor: 'divider',
        p: 1,
        position: 'relative',
      }}
    >
      {content}
      {compact && maxHeight && (
        <Box
          sx={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 40,
            background: 'linear-gradient(transparent, var(--joy-palette-background-surface))',
            pointerEvents: 'none',
          }}
        />
      )}
    </Box>
  );
};

export default TavernArtifactRenderer;

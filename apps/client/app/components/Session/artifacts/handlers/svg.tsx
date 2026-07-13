import React, { useMemo } from 'react';
import { Box, Typography } from '@mui/joy';
import { Image as SvgIcon } from '@mui/icons-material';
import DOMPurify from 'dompurify';
import type { SvgArtifact } from '@bike4mind/common';
import ArtifactPreviewCard from '@client/app/components/GenAI/ArtifactPreviewCard';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

const sanitizeSvg = (raw: string): string =>
  DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: [
      'svg',
      'g',
      'path',
      'circle',
      'ellipse',
      'line',
      'rect',
      'polyline',
      'polygon',
      'text',
      'tspan',
      'textPath',
      'defs',
      'clipPath',
      'mask',
      'pattern',
      'use',
      'symbol',
      'linearGradient',
      'radialGradient',
      'stop',
      'filter',
      'feOffset',
      'feFlood',
      'feComposite',
      'feColorMatrix',
      'feGaussianBlur',
      'marker',
      'image',
      'title',
      'desc',
      'animate',
      'animateTransform',
      'animateMotion',
      'set',
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });

const SvgPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId }) => {
  const sanitized = useMemo(() => sanitizeSvg(artifact.content), [artifact.content]);
  const svgTitle = artifact.title || 'SVG Graphic';

  const svgArtifact: SvgArtifact = useMemo(
    () => ({
      id: artifactId,
      type: 'svg',
      title: svgTitle,
      content: artifact.content,
      metadata: { sanitized: true },
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    [artifactId, svgTitle, artifact.content]
  );

  const lineCount = artifact.content.split('\n').length;

  return (
    <Box data-testid={`artifact-preview-svg-${artifactId}`}>
      <ArtifactPreviewCard
        artifactId={svgArtifact.id}
        artifactType="svg"
        mimeType="image/svg+xml"
        artifactContent={svgArtifact}
        title={svgTitle}
        icon={<SvgIcon color="primary" sx={{ fontSize: '16px' }} />}
        chipLabel="SVG"
        chipColor="primary"
        testIdPrefix="svg"
        // The graphic IS the artifact: always shown, never collapsed, and no source view
        // (so no code toggle) -- but the markup is still worth saving as a file.
        collapsible={false}
        source={artifact.content}
        saveTooltip="Save as SVG file"
        saveFile={() => ({
          fileName: `${svgTitle.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.svg`,
          mimeType: 'image/svg+xml',
          successMessage: 'Saved SVG as file',
        })}
        actions={{ save: true }}
        stats={
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {lineCount} lines
          </Typography>
        }
        renderPreview={() => (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              '& svg': {
                maxWidth: '100%',
                height: 'auto',
              },
            }}
            dangerouslySetInnerHTML={{ __html: sanitized }}
          />
        )}
      />
    </Box>
  );
};

registerArtifactType({ type: 'svg', PreviewCard: SvgPreviewCard });

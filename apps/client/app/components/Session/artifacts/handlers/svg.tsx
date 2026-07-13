import React, { useMemo } from 'react';
import { Box } from '@mui/joy';
import DOMPurify from 'dompurify';
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

  return (
    <Box
      data-testid={`artifact-preview-svg-${artifactId}`}
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
  );
};

registerArtifactType({ type: 'svg', PreviewCard: SvgPreviewCard });

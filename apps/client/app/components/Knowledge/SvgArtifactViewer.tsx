import React, { useMemo, useEffect } from 'react';
import { Box, Typography, Alert } from '@mui/joy';
import { type SvgArtifact } from '@bike4mind/common';
import { validateArtifactContent } from '@client/app/utils/artifactParser';
import DOMPurify from 'dompurify';

interface SvgArtifactViewerProps {
  artifact: SvgArtifact;
  onError?: (error: string) => void;
}

// Generate sanitized SVG for safe rendering
const generateSanitizedSVG = (svgContent: string) => {
  // Configure DOMPurify specifically for SVG content
  const cleanSvg = DOMPurify.sanitize(svgContent, {
    USE_PROFILES: { svg: true, svgFilters: true },
    WHOLE_DOCUMENT: false,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    SANITIZE_DOM: true,
    KEEP_CONTENT: true,
    IN_PLACE: false,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    SAFE_FOR_TEMPLATES: false,

    // SVG-specific tags
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
      'marker',
      'defs',
      'clipPath',
      'mask',
      'pattern',
      'image',
      'switch',
      'foreignObject',
      'use',
      'symbol',
      'linearGradient',
      'radialGradient',
      'stop',
      'animate',
      'animateTransform',
      'animateMotion',
      'set',
      'filter',
      'feOffset',
      'feFlood',
      'feComposite',
      'feColorMatrix',
      'feGaussianBlur',
      'title',
      'desc',
      'metadata',
    ],

    // SVG-specific attributes
    ADD_ATTR: [
      'xmlns',
      'xmlns:xlink',
      'viewBox',
      'preserveAspectRatio',
      'width',
      'height',
      'x',
      'y',
      'x1',
      'y1',
      'x2',
      'y2',
      'cx',
      'cy',
      'r',
      'rx',
      'ry',
      'd',
      'points',
      'fill',
      'stroke',
      'stroke-width',
      'stroke-linecap',
      'stroke-linejoin',
      'stroke-dasharray',
      'stroke-dashoffset',
      'opacity',
      'fill-opacity',
      'stroke-opacity',
      'transform',
      'rotate',
      'scale',
      'translate',
      'skewX',
      'skewY',
      'matrix',
      'gradientUnits',
      'gradientTransform',
      'spreadMethod',
      'offset',
      'stop-color',
      'stop-opacity',
      'patternUnits',
      'patternTransform',
      'patternContentUnits',
      'markerUnits',
      'markerWidth',
      'markerHeight',
      'orient',
      'refX',
      'refY',
      'clipPathUnits',
      'maskUnits',
      'maskContentUnits',
      'filterUnits',
      'primitiveUnits',
      'class',
      'id',
      'style',
    ],

    // Forbid dangerous elements and attributes
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'style'],
    FORBID_ATTR: [
      'onload',
      'onerror',
      'onclick',
      'onmouseover',
      'onmouseout',
      'onfocus',
      'onblur',
      'onchange',
      'href',
      'xlink:href',
    ],

    // Use safe regex for allowed protocols
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });

  return cleanSvg;
};

const SvgArtifactViewer: React.FC<SvgArtifactViewerProps> = ({ artifact, onError }) => {
  // Validate the artifact content
  const validation = useMemo(() => {
    return validateArtifactContent(artifact.type, artifact.content);
  }, [artifact.content, artifact.type]);

  const sanitizedSVG = useMemo(() => {
    if (!validation.isValid) return null;
    return generateSanitizedSVG(artifact.content);
  }, [artifact.content, validation.isValid]);

  useEffect(() => {
    if (!validation.isValid) {
      const errorMsg = `Invalid SVG artifact: ${validation.errors.join(', ')}`;
      onError?.(errorMsg);
    }
  }, [validation.isValid, validation.errors, onError]);

  if (!validation.isValid) {
    return (
      <Alert color="danger" sx={{ m: 2 }}>
        <Typography>Invalid SVG artifact: {validation.errors.join(', ')}</Typography>
      </Alert>
    );
  }

  if (!sanitizedSVG) {
    return (
      <Alert color="warning">
        <Typography level="title-sm">Empty SVG Content</Typography>
        <Typography level="body-sm" sx={{ mt: 1 }}>
          The SVG artifact contains no valid content to display.
        </Typography>
      </Alert>
    );
  }

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
        overflow: 'auto',
      }}
    >
      <Box
        dangerouslySetInnerHTML={{ __html: sanitizedSVG }}
        sx={{
          '& svg': {
            maxWidth: '100%',
            maxHeight: '100%',
            height: 'auto',
            width: 'auto',
          },
        }}
      />
    </Box>
  );
};

export default SvgArtifactViewer;

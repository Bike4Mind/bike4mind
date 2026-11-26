import React, { useMemo } from 'react';
import { Box } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import { toSvgImageSource } from '@client/app/utils/svgSanitizer';

interface SafeSvgImageProps {
  svg: string;
  alt: string;
  testId?: string;
  sx?: SxProps;
}

/**
 * Renders untrusted SVG markup as an image, never inline in the app document. As an image the SVG
 * is its own document: currentColor resolves to black, and page fonts, link clicks and text
 * selection do not apply.
 */
const SafeSvgImage: React.FC<SafeSvgImageProps> = ({ svg, alt, testId, sx }) => {
  const source = useMemo(() => toSvgImageSource(svg), [svg]);
  if (!source) return null;
  return (
    <Box
      component="img"
      src={source.src}
      alt={alt}
      data-testid={testId}
      sx={[
        { display: 'block', maxWidth: '100%', height: 'auto', width: source.hasIntrinsicWidth ? 'auto' : '100%' },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    />
  );
};

export default SafeSvgImage;

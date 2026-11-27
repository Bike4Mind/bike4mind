import React, { useMemo, useEffect } from 'react';
import { Box, Typography, Alert } from '@mui/joy';
import { type SvgArtifact } from '@bike4mind/common';
import { validateArtifactContent } from '@bike4mind/server-utils/app/utils/artifactParser';
import { sanitizeArtifactSvg } from '@client/app/utils/svgSanitizer';
import SafeSvgImage from '@client/app/components/common/SafeSvgImage';
import SvgPlate from '@client/app/components/common/SvgPlate';

interface SvgArtifactViewerProps {
  artifact: SvgArtifact;
  onError?: (error: string) => void;
}

const SvgArtifactViewer: React.FC<SvgArtifactViewerProps> = ({ artifact, onError }) => {
  // Validate the artifact content
  const validation = useMemo(() => {
    return validateArtifactContent(artifact.type, artifact.content);
  }, [artifact.content, artifact.type]);

  const sanitizedSVG = useMemo(() => {
    if (!validation.isValid) return null;
    return sanitizeArtifactSvg(artifact.content) || null;
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
      <SvgPlate sx={{ width: '100%', maxHeight: '100%', overflow: 'auto' }}>
        <SafeSvgImage svg={sanitizedSVG} alt={artifact.title || 'SVG artifact'} testId="svg-artifact-viewer-image" />
      </SvgPlate>
    </Box>
  );
};

export default SvgArtifactViewer;

import React, { useMemo } from 'react';
import { Box } from '@mui/joy';
import type { SvgArtifact } from '@bike4mind/common';
import ArtifactPreviewCard from '@client/app/components/GenAI/ArtifactPreviewCard';
import { artifactFileName } from '@client/app/utils/artifactFileName';
import SafeSvgImage from '@client/app/components/common/SafeSvgImage';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

const SvgPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId }) => {
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

  return (
    <Box data-testid={`artifact-preview-svg-${artifactId}`}>
      <ArtifactPreviewCard
        artifactId={svgArtifact.id}
        artifactType="svg"
        sourceLanguage="xml"
        mimeType="image/svg+xml"
        artifactContent={svgArtifact}
        contentKey={artifact.content}
        title={svgTitle}
        chipLabel="SVG"
        testIdPrefix="svg"
        // The graphic IS the artifact: always shown, never collapsed, and no source view
        // (so no code toggle) -- but the markup is still worth saving as a file.
        source={artifact.content}
        saveTooltip="Save as SVG file"
        saveFile={() => ({
          fileName: artifactFileName(svgTitle, 'svg', 'svg-graphic'),
          mimeType: 'image/svg+xml',
          successMessage: 'Saved SVG as file',
        })}
        actions={{ save: true }}
        renderPreview={() => (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              // A fixed white plate in both schemes, like the HTML and React sandboxes.
              // The preview used to be transparent, so an SVG drawn in light strokes for
              // a dark canvas disappeared on a light card, and dark strokes disappeared
              // on a dark one. An SVG is authored artwork and cannot be re-themed; giving
              // it the canvas most artwork assumes is the only reading that never hides it.
              backgroundColor: '#FFFFFF',
              borderRadius: '6px',
              p: 1,
            }}
          >
            <SafeSvgImage svg={artifact.content} alt={svgTitle} testId={`svg-preview-image-${artifactId}`} />
          </Box>
        )}
      />
    </Box>
  );
};

registerArtifactType({ type: 'svg', PreviewCard: SvgPreviewCard });

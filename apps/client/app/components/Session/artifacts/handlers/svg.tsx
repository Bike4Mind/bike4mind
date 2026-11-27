import React, { useMemo } from 'react';
import { Box } from '@mui/joy';
import type { SvgArtifact } from '@bike4mind/common';
import ArtifactPreviewCard from '@client/app/components/GenAI/ArtifactPreviewCard';
import { artifactFileName } from '@client/app/utils/artifactFileName';
import SafeSvgImage from '@client/app/components/common/SafeSvgImage';
import SvgPlate from '@client/app/components/common/SvgPlate';
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
          <SvgPlate>
            <SafeSvgImage svg={artifact.content} alt={svgTitle} testId={`svg-preview-image-${artifactId}`} />
          </SvgPlate>
        )}
      />
    </Box>
  );
};

registerArtifactType({ type: 'svg', PreviewCard: SvgPreviewCard });

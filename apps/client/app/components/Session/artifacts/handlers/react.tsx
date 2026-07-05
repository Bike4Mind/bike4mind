import React from 'react';
import { Box } from '@mui/joy';
import { ReactArtifact } from '@bike4mind/common';
import { extractReactDependencies, checkHasDefaultExport } from '@client/app/utils/artifactParser';
import ReactArtifactPreviewCard from '../../../GenAI/ReactArtifactPreviewCard';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

const ReactPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId, index }) => {
  const reactArtifact: ReactArtifact = {
    id: artifactId,
    type: 'react',
    title: artifact.title,
    content: artifact.content,
    metadata: {
      dependencies: extractReactDependencies(artifact.content),
      hasDefaultExport: checkHasDefaultExport(artifact.content),
      errorBoundary: true,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return (
    <Box data-testid={`artifact-preview-react-${artifactId}`}>
      <ReactArtifactPreviewCard key={index} artifact={reactArtifact} />
    </Box>
  );
};

registerArtifactType({ type: 'react', PreviewCard: ReactPreviewCard });

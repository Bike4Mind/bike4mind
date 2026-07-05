import React from 'react';
import { Box } from '@mui/joy';
import type { HtmlArtifact } from '@bike4mind/common';
import HtmlArtifactPreviewCard from '../../../GenAI/HtmlArtifactPreviewCard';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

const HtmlPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId, index }) => {
  const htmlArtifact: HtmlArtifact = {
    id: artifactId,
    type: 'html',
    title: artifact.title,
    content: artifact.content,
    metadata: {
      sanitized: true,
      // Vestigial - no longer gates script execution (the iframe sandbox + route
      // CSP do). Retained because the persisted HtmlArtifact zod schema still
      // declares it; removing the schema field is a separate follow-up.
      allowedScripts: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return (
    <Box data-testid={`artifact-preview-html-${artifactId}`}>
      <HtmlArtifactPreviewCard key={index} artifact={htmlArtifact} />
    </Box>
  );
};

registerArtifactType({ type: 'html', PreviewCard: HtmlPreviewCard });

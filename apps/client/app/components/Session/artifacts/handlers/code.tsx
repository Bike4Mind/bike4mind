import React from 'react';
import { Box } from '@mui/joy';
import CodeArtifactPreviewCard from '../../../GenAI/CodeArtifactPreviewCard';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

const CodePreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId, index }) => {
  const codeArtifact = {
    title: artifact.title,
    description: artifact.content.split('\n').slice(0, 2).join('\n') + '...',
    language: artifact.language || 'typescript',
    code: artifact.content,
    lineCount: artifact.content.split('\n').length,
  };
  return (
    <Box data-testid={`artifact-preview-code-${artifactId}`}>
      <CodeArtifactPreviewCard key={index} data={codeArtifact} artifactId={artifactId} />
    </Box>
  );
};

registerArtifactType({ type: 'code', PreviewCard: CodePreviewCard });

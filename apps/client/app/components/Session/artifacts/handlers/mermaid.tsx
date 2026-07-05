import React from 'react';
import { Box, Stack, Typography } from '@mui/joy';
import { AccountTree as MermaidIcon } from '@mui/icons-material';
import type { MermaidArtifact } from '@bike4mind/common';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

const MermaidPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId, index }) => {
  const mermaidArtifact: MermaidArtifact = {
    id: artifactId,
    type: 'mermaid',
    title: artifact.title,
    content: artifact.content,
    metadata: {
      chartType: 'flowchart',
      description: 'Generated diagram',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return (
    <Box
      key={index}
      data-testid={`artifact-preview-mermaid-${artifactId}`}
      sx={{
        my: 2,
        cursor: 'pointer',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 'sm',
        p: 2,
        '&:hover': {
          bgcolor: 'background.level1',
        },
      }}
      onClick={() => {
        setSessionLayout({
          layout: 'vertical',
          artifactData: {
            type: 'mermaid',
            content: mermaidArtifact,
            mimeType: 'text/plain',
            id: mermaidArtifact.id,
          },
        });
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" mb={1}>
        <MermaidIcon sx={{ color: 'neutral.300', fontSize: '1.25rem' }} />
        <Typography level="body-sm">{artifact.title}</Typography>
      </Stack>
      <Box
        component="pre"
        data-testid={`mermaid-code-preview-${artifactId}`}
        sx={{
          p: 2,
          borderRadius: 'sm',
          bgcolor: 'background.level1',
          overflow: 'auto',
          fontSize: '0.875rem',
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          maxHeight: '100px',
        }}
      >
        {artifact.content.length > 200 ? `${artifact.content.slice(0, 200)}…` : artifact.content}
      </Box>
    </Box>
  );
};

registerArtifactType({ type: 'mermaid', PreviewCard: MermaidPreviewCard });

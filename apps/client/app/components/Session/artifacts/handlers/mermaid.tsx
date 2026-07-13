import React from 'react';
import { Box, Typography } from '@mui/joy';
import { AccountTree as MermaidIcon } from '@mui/icons-material';
import type { MermaidArtifact } from '@bike4mind/common';
import MermaidChart from '@client/app/components/Charts/MermaidChart';
import ArtifactPreviewCard from '@client/app/components/GenAI/ArtifactPreviewCard';
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

  const lineCount = artifact.content.split('\n').length;

  return (
    <Box key={index} data-testid={`artifact-preview-mermaid-${artifactId}`} sx={{ my: 2 }}>
      <ArtifactPreviewCard
        artifactId={mermaidArtifact.id}
        artifactType="mermaid"
        mimeType="text/plain"
        artifactContent={mermaidArtifact}
        title={mermaidArtifact.title}
        icon={<MermaidIcon color="primary" sx={{ fontSize: '16px' }} />}
        chipLabel="Mermaid"
        chipColor="primary"
        testIdPrefix="mermaid"
        source={artifact.content}
        copyTooltip="Copy diagram source to clipboard"
        copyMessage="Mermaid source copied to clipboard"
        saveTooltip="Save as Mermaid file"
        saveFile={() => ({
          fileName: `${mermaidArtifact.title.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.mmd`,
          mimeType: 'text/plain',
          successMessage: 'Saved diagram as file',
        })}
        actions={{ copy: true, save: true, codeToggle: true }}
        defaultRenderedView
        stats={
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {lineCount} lines
          </Typography>
        }
        renderPreview={() => <MermaidChart chartDefinition={artifact.content} readOnly />}
      />
    </Box>
  );
};

registerArtifactType({ type: 'mermaid', PreviewCard: MermaidPreviewCard });

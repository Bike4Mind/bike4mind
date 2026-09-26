import React from 'react';
import { Box } from '@mui/joy';
import type { MermaidArtifact } from '@bike4mind/common';
import MermaidChart from '@client/app/components/Charts/MermaidChart';
import ArtifactPreviewCard from '@client/app/components/GenAI/ArtifactPreviewCard';
import { artifactFileName } from '@client/app/utils/artifactFileName';
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
    <Box key={index} data-testid={`artifact-preview-mermaid-${artifactId}`}>
      <ArtifactPreviewCard
        artifactId={mermaidArtifact.id}
        artifactType="mermaid"
        mimeType="text/plain"
        artifactContent={mermaidArtifact}
        contentKey={artifact.content}
        title={mermaidArtifact.title}
        chipLabel="Mermaid"
        testIdPrefix="mermaid"
        source={artifact.content}
        copyTooltip="Copy diagram source to clipboard"
        copyMessage="Mermaid source copied to clipboard"
        saveTooltip="Save as Mermaid file"
        saveFile={() => ({
          fileName: artifactFileName(mermaidArtifact.title, 'mmd', 'mermaid-chart'),
          mimeType: 'text/plain',
          successMessage: 'Saved diagram as file',
        })}
        actions={{ copy: true, save: true }}
        defaultRenderedView
        renderPreview={() => (
          // Bounded like the react/html inline renders. Without a cap the card took whatever
          // height the rendered SVG asked for, so re-rendering it - which opening and closing
          // the viewer triggers - could leave the card standing at full diagram height.
          <Box sx={{ height: '240px', overflow: 'auto' }}>
            <MermaidChart chartDefinition={artifact.content} readOnly chromeless />
          </Box>
        )}
      />
    </Box>
  );
};

registerArtifactType({ type: 'mermaid', PreviewCard: MermaidPreviewCard });

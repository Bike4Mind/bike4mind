import React from 'react';
import { Box, Typography } from '@mui/joy';
import type { PythonArtifact } from '@bike4mind/common';
import ArtifactPreviewCard from '@client/app/components/GenAI/ArtifactPreviewCard';
import { artifactFileName } from '@client/app/utils/artifactFileName';
import { detectPythonPackages } from '@client/app/utils/pythonPackages';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

const PythonPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId, index }) => {
  const packages = detectPythonPackages(artifact.content);
  const title = artifact.title || 'Python Script';

  const pythonArtifact: PythonArtifact = {
    id: artifactId,
    type: 'python',
    title,
    content: artifact.content,
    metadata: {
      packages,
      hasOutput: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const lineCount = artifact.content.split('\n').length;

  return (
    <Box key={index} data-testid={`artifact-preview-python-${artifactId}`}>
      <ArtifactPreviewCard
        artifactId={pythonArtifact.id}
        artifactType="python"
        sourceLanguage="python"
        mimeType="application/vnd.ant.python"
        artifactContent={pythonArtifact}
        contentKey={artifact.content}
        title={title}
        chipLabel="Python"
        testIdPrefix="python"
        source={artifact.content}
        copyTooltip="Copy code to clipboard"
        copyMessage="Python code copied to clipboard"
        saveTooltip="Save as Python file"
        saveFile={() => ({
          fileName: artifactFileName(title, 'py', 'python-script'),
          mimeType: 'text/x-python',
          successMessage: 'Saved Python script as file',
        })}
        actions={{ copy: true, save: true }}
        // No inline render: running Python means the Pyodide playground, which lives in
        // the side panel. The card shows source; "open in full viewer" runs it.
        stats={
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {/* One line, not two siblings: separate pieces read as unrelated labels.
                '\u2022' as an escape - source here stays ASCII. */}
            {[`${lineCount} lines`, packages.length > 0 ? packages.join(', ') : null].filter(Boolean).join(' \u2022 ')}
          </Typography>
        }
      />
    </Box>
  );
};

registerArtifactType({ type: 'python', PreviewCard: PythonPreviewCard });

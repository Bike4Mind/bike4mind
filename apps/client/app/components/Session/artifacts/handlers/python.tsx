import React from 'react';
import { Box, Typography } from '@mui/joy';
import type { PythonArtifact } from '@bike4mind/common';
import ArtifactPreviewCard from '@client/app/components/GenAI/ArtifactPreviewCard';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

const SUPPORTED_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scipy', 'seaborn', 'sklearn'];

const detectPackages = (code: string): string[] => {
  const patterns = [/^import\s+(\w+)/gm, /^from\s+(\w+)\s+import/gm];
  const detected: string[] = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      if (SUPPORTED_PACKAGES.includes(match[1])) detected.push(match[1]);
    }
  }
  return detected;
};

const PythonPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId, index }) => {
  const packages = detectPackages(artifact.content);
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
        mimeType="application/vnd.ant.python"
        artifactContent={pythonArtifact}
        title={title}
        chipLabel="Python"
        testIdPrefix="python"
        source={artifact.content}
        copyTooltip="Copy code to clipboard"
        copyMessage="Python code copied to clipboard"
        saveTooltip="Save as Python file"
        saveFile={() => ({
          fileName: `${title.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.py`,
          mimeType: 'text/x-python',
          successMessage: 'Saved Python script as file',
        })}
        actions={{ copy: true, save: true }}
        // No inline render: running Python means the Pyodide playground, which lives in
        // the side panel. The card shows source; "open in full viewer" runs it.
        stats={
          <>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              {lineCount} lines
            </Typography>
            {packages.length > 0 && (
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                {packages.join(', ')}
              </Typography>
            )}
          </>
        }
      />
    </Box>
  );
};

registerArtifactType({ type: 'python', PreviewCard: PythonPreviewCard });

import React from 'react';
import { Box, Stack, Chip, Typography } from '@mui/joy';
import { Terminal as PythonIcon } from '@mui/icons-material';
import type { PythonArtifact } from '@bike4mind/common';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

const PythonPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId, index }) => {
  const pythonArtifact: PythonArtifact = {
    id: artifactId,
    type: 'python',
    title: artifact.title || 'Python Script',
    content: artifact.content,
    metadata: {
      packages: [],
      hasOutput: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Extract detected packages from import statements
  const importPatterns = [/^import\s+(\w+)/gm, /^from\s+(\w+)\s+import/gm];
  const supportedPackages = ['numpy', 'pandas', 'matplotlib', 'scipy', 'seaborn', 'sklearn'];
  const detectedPackages: string[] = [];

  for (const pattern of importPatterns) {
    let match;
    while ((match = pattern.exec(artifact.content)) !== null) {
      if (supportedPackages.includes(match[1])) {
        detectedPackages.push(match[1]);
      }
    }
  }
  pythonArtifact.metadata.packages = detectedPackages;

  const lineCount = artifact.content.split('\n').length;

  return (
    <Box
      key={index}
      data-testid={`artifact-preview-python-${artifactId}`}
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
        console.log('[PromptReplies] Python artifact clicked:', {
          type: 'python',
          id: pythonArtifact.id,
          title: pythonArtifact.title,
        });
        setSessionLayout({
          layout: 'vertical',
          artifactData: {
            type: 'python',
            content: pythonArtifact,
            mimeType: 'application/vnd.ant.python',
            id: pythonArtifact.id,
          },
        });
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" mb={1}>
        <PythonIcon sx={{ color: 'danger.500', fontSize: '1.25rem' }} />
        <Typography level="body-sm">{pythonArtifact.title}</Typography>
        <Chip size="sm" variant="solid" color="danger">
          🐍 Python Playground
        </Chip>
      </Stack>
      <Typography level="body-xs" color="neutral">
        {lineCount} lines{detectedPackages.length > 0 ? ` • ${detectedPackages.join(', ')}` : ''}
      </Typography>
      <Box
        component="pre"
        sx={{
          mt: 1,
          p: 1.5,
          borderRadius: 'sm',
          bgcolor: 'background.level1',
          overflow: 'hidden',
          fontSize: '0.75rem',
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          maxHeight: '80px',
          textOverflow: 'ellipsis',
        }}
      >
        {artifact.content.slice(0, 200)}
        {artifact.content.length > 200 ? '...' : ''}
      </Box>
    </Box>
  );
};

registerArtifactType({ type: 'python', PreviewCard: PythonPreviewCard });

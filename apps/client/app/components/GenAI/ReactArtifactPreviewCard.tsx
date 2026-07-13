import React from 'react';
import { Chip, Stack, Typography } from '@mui/joy';
import { Code as ReactIcon } from '@mui/icons-material';
import { type ReactArtifact } from '@bike4mind/common';
import InlineArtifactPreview from './InlineArtifactPreview';
import ArtifactPreviewCard, { getComplexityColor } from './ArtifactPreviewCard';

interface ReactArtifactPreviewCardProps {
  artifact: ReactArtifact;
  onExpand?: () => void;
}

const ReactArtifactPreviewCard: React.FC<ReactArtifactPreviewCardProps> = ({ artifact, onExpand }) => {
  const dependencies = artifact.metadata?.dependencies || [];
  const lineCount = artifact.content.split('\n').length;

  return (
    <ArtifactPreviewCard
      artifactId={artifact.id}
      artifactType="react"
      mimeType="application/vnd.ant.react"
      artifactContent={artifact}
      title={artifact.title}
      icon={<ReactIcon color="primary" sx={{ fontSize: '16px' }} />}
      chipLabel="React"
      chipColor={getComplexityColor(artifact.content)}
      testIdPrefix="react"
      source={artifact.content}
      copyTooltip="Copy code to clipboard"
      copyMessage="React component copied to clipboard"
      saveTooltip="Save as TypeScript file"
      saveFile={() => ({
        fileName: `${artifact.title.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.tsx`,
        mimeType: 'text/typescript',
        successMessage: 'Saved React component as TypeScript file',
      })}
      actions={{ copy: true, save: true, codeToggle: true }}
      defaultRenderedView={false}
      stats={
        <>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {lineCount} lines
          </Typography>
          {dependencies.length > 0 && (
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              {dependencies.length} {dependencies.length === 1 ? 'dependency' : 'dependencies'}
            </Typography>
          )}
        </>
      }
      extra={
        dependencies.length > 0 ? (
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            {dependencies.slice(0, 3).map((dep, index) => (
              <Chip key={index} size="sm" variant="outlined" color="neutral">
                {dep}
              </Chip>
            ))}
            {dependencies.length > 3 && (
              <Chip size="sm" variant="outlined" color="neutral">
                +{dependencies.length - 3} more
              </Chip>
            )}
          </Stack>
        ) : null
      }
      renderPreview={() => (
        <InlineArtifactPreview
          artifact={artifact}
          type="react"
          maxHeight={400}
          onError={error => console.error('[ReactArtifactPreviewCard] Preview error:', error)}
        />
      )}
      onExpand={onExpand}
    />
  );
};

export default ReactArtifactPreviewCard;

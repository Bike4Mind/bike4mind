import React from 'react';
import { Chip, Stack, Typography } from '@mui/joy';
import { type ReactArtifact } from '@bike4mind/common';
import InlineArtifactPreview from './InlineArtifactPreview';
import ArtifactPreviewCard from './ArtifactPreviewCard';
import { artifactFileName } from '@client/app/utils/artifactFileName';
import type { ReactArtifactGroupRole } from '@client/app/utils/reactArtifactGroup';

interface ReactArtifactPreviewCardProps {
  artifact: ReactArtifact;
  /** Multi-file role: an entry renders with its files, a sibling shows its source instead. */
  group?: ReactArtifactGroupRole;
  onExpand?: () => void;
}

const ReactArtifactPreviewCard: React.FC<ReactArtifactPreviewCardProps> = ({ artifact, group, onExpand }) => {
  const dependencies = artifact.metadata?.dependencies || [];
  const files = group?.role === 'entry' ? group.files : undefined;

  return (
    <ArtifactPreviewCard
      sourceLanguage="tsx"
      artifactId={artifact.id}
      artifactType="react"
      mimeType="application/vnd.ant.react"
      artifactContent={artifact}
      reactGroup={group}
      contentKey={artifact.content}
      title={artifact.title}
      chipLabel="React"
      testIdPrefix="react"
      source={artifact.content}
      copyTooltip="Copy code to clipboard"
      copyMessage="React component copied to clipboard"
      saveTooltip="Save as TypeScript file"
      saveFile={() => ({
        fileName: artifactFileName(artifact.title, 'tsx', 'react-component'),
        mimeType: 'text/typescript',
        successMessage: 'Saved React component as TypeScript file',
      })}
      actions={{ copy: true, save: true }}
      stats={
        group?.role === 'sibling' ? (
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="react-artifact-used-by-label">
            Used by {group.entryTitle}
          </Typography>
        ) : undefined
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
      // A sibling cannot render alone (it is a module of the entry's app), so its card shows the source.
      renderPreview={
        group?.role === 'sibling'
          ? undefined
          : () => (
              <InlineArtifactPreview
                artifact={artifact}
                type="react"
                files={files}
                maxHeight={240}
                onError={error => console.error('[ReactArtifactPreviewCard] Preview error:', error)}
              />
            )
      }
      onExpand={onExpand}
    />
  );
};

export default ReactArtifactPreviewCard;

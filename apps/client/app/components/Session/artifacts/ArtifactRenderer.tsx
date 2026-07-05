import React, { FC, useState, useEffect } from 'react';
import { Box, Typography } from '@mui/joy';
import { generateCompleteArtifactId, getArtifactTimestamp } from '@client/app/utils/artifactParser';
import { useArtifactIdResolver } from './ArtifactIdResolver';
import { getArtifactHandler, type ParsedArtifact } from './registry';

// Ensure all handlers are registered
import './handlers';

type ArtifactRendererProps = {
  artifact: ParsedArtifact;
  index: number;
  messageId: string;
  sessionId?: string;
};

/**
 * Resolves the artifact ID asynchronously, then dispatches to the appropriate
 * handler's PreviewCard via the registry.
 */
const ArtifactRenderer: FC<ArtifactRendererProps> = ({ artifact, index, messageId, sessionId }) => {
  const { resolveArtifactId } = useArtifactIdResolver();
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(true);

  useEffect(() => {
    let isCancelled = false;

    const resolveId = async () => {
      try {
        const id = await resolveArtifactId(
          artifact.type,
          artifact.identifier ?? '',
          artifact.content,
          messageId,
          index,
          sessionId
        );
        if (!isCancelled) {
          setResolvedId(id);
        }
      } catch (error) {
        console.error('Error resolving artifact ID:', error);
        if (!isCancelled) {
          const timestamp = getArtifactTimestamp(messageId);
          const fallbackId = generateCompleteArtifactId(artifact.type, artifact.identifier ?? '', timestamp, index);
          setResolvedId(fallbackId);
        }
      } finally {
        if (!isCancelled) {
          setIsResolving(false);
        }
      }
    };

    resolveId();

    return () => {
      isCancelled = true;
    };
  }, [artifact.type, artifact.identifier, artifact.content, messageId, index, sessionId, resolveArtifactId]);

  if (isResolving || !resolvedId) {
    return (
      <Box
        data-testid="artifact-loading"
        sx={{ my: 2, p: 2, border: '1px dashed', borderColor: 'neutral.300', borderRadius: 'sm' }}
      >
        <Typography level="body-sm" color="neutral">
          Loading artifact...
        </Typography>
      </Box>
    );
  }

  const handler = getArtifactHandler(artifact.type);
  if (!handler) {
    console.warn(`[ArtifactRenderer] No handler registered for artifact type "${artifact.type}"`);
    return null;
  }

  return (
    <Box data-testid={`artifact-renderer-${artifact.type}`}>
      <handler.PreviewCard artifact={artifact} artifactId={resolvedId} index={index} />
    </Box>
  );
};

export default ArtifactRenderer;

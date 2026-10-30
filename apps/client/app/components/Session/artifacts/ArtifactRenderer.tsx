import React, { FC, useState, useEffect } from 'react';
import { Box, Typography } from '@mui/joy';
import { generateCompleteArtifactId, getArtifactTimestamp } from '@client/app/utils/artifactParser';
import { getCachedArtifactId, getProvisionalArtifactId, useArtifactIdResolver } from './ArtifactIdResolver';
import { getArtifactHandler, type ParsedArtifact } from './registry';
import type { ReactArtifactGroupRole } from '@client/app/utils/reactArtifactGroup';

// Ensure all handlers are registered
import './handlers';

type ArtifactRendererProps = {
  artifact: ParsedArtifact;
  /** Position in the reply's full parse, the index useStreamingArtifactPersistence mints ids with. */
  index: number;
  messageId: string;
  sessionId?: string;
  /** This artifact's place in a multi-file React app, from groupReactArtifacts over its reply. */
  reactGroup?: ReactArtifactGroupRole;
};

/**
 * Resolves the artifact ID asynchronously, then dispatches to the appropriate
 * handler's PreviewCard via the registry.
 */
const ArtifactRenderer: FC<ArtifactRendererProps> = ({ artifact, index, messageId, sessionId, reactGroup }) => {
  const { resolveArtifactId } = useArtifactIdResolver();
  const identifier = artifact.identifier ?? '';
  // Seeded from the module cache rather than starting at null: resolution is async, so a
  // null start renders the loading placeholder for a frame on every mount. In a virtualized
  // transcript that is every time the message scrolls back into view, and since the
  // placeholder is shorter than the card, the list measures the short frame and then jumps
  // to correct itself. A resolved artifact now renders at its real height straight away.
  const cachedId = getCachedArtifactId(artifact.type, identifier, sessionId);
  const provisionalId = cachedId
    ? null
    : getProvisionalArtifactId(artifact.type, identifier, sessionId, messageId, index);
  const [resolvedId, setResolvedId] = useState<string | null>(cachedId ?? provisionalId);
  const [isResolving, setIsResolving] = useState(!(cachedId ?? provisionalId));
  // Bumped once this reply's rows are saved, so a provisional id is checked against them.
  const [persistedCount, setPersistedCount] = useState(0);

  useEffect(() => {
    const onPersisted = (event: Event) => {
      if ((event as CustomEvent<{ questId?: string } | undefined>).detail?.questId === messageId) {
        setPersistedCount(count => count + 1);
      }
    };
    window.addEventListener('artifacts-persisted', onPersisted);
    return () => window.removeEventListener('artifacts-persisted', onPersisted);
  }, [messageId]);

  useEffect(() => {
    // A provisional id renders immediately, but always recheck it: the row may have saved while
    // this virtualized card was unmounted. Only a database-confirmed id can skip the lookup.
    if (cachedId) return;
    let isCancelled = false;

    const resolveId = async () => {
      try {
        const id = await resolveArtifactId(artifact.type, identifier, artifact.content, messageId, index, sessionId);
        if (!isCancelled) {
          setResolvedId(id);
        }
      } catch (error) {
        console.error('Error resolving artifact ID:', error);
        if (!isCancelled) {
          const timestamp = getArtifactTimestamp(messageId);
          const fallbackId = generateCompleteArtifactId(artifact.type, identifier, timestamp, index);
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
  }, [
    artifact.type,
    identifier,
    artifact.content,
    messageId,
    index,
    sessionId,
    resolveArtifactId,
    cachedId,
    persistedCount,
  ]);

  const artifactId = cachedId ?? provisionalId ?? resolvedId;

  if (!artifactId || (isResolving && !cachedId && !provisionalId)) {
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
      <handler.PreviewCard artifact={artifact} artifactId={artifactId} index={index} reactGroup={reactGroup} />
    </Box>
  );
};

export default ArtifactRenderer;

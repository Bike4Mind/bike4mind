import { useCallback, useMemo, useRef } from 'react';
import perfLogger from '../utils/performanceLogger';
import {
  parseArtifacts,
  extractReactDependencies,
  checkHasDefaultExport,
  generateCompleteArtifactId,
  convertCodeBlocksToArtifacts,
  getArtifactTimestamp,
} from '../utils/artifactParser';
import { persistArtifacts } from '../utils/artifactPersistence';

/**
 * useStreamingArtifactPersistence - owns extracting + persisting artifacts from
 * a completed quest's replies.
 *
 * Extracted from useSubscribeChatCompletion. Named to avoid colliding with the
 * pre-existing `useArtifactPersistence` hook, which checks
 * whether a single artifact exists in the database. This hook parses artifacts
 * (or converts code blocks to artifacts) from a finished quest, persists them,
 * and broadcasts the resulting ids - deduplicating so a quest is only persisted
 * once.
 */
export function useStreamingArtifactPersistence() {
  // Track which quests have had their artifacts persisted to prevent duplicates
  const persistedQuestsRef = useRef<Set<string>>(new Set());

  // Extract and save artifacts from a completed quest, skipping quests already persisted.
  const persistArtifactsFromQuest = useCallback(
    (quest: { id?: string; sessionId?: string; replies?: (string | null | undefined)[] }) => {
      if (!quest || !quest.id || persistedQuestsRef.current.has(quest.id)) {
        return;
      }
      if (!quest.replies || quest.replies.length === 0) {
        return;
      }

      const allReplies = quest.replies.join('\n');

      // First try to parse existing artifact tags
      let parseResult = parseArtifacts(allReplies);

      // If no artifacts found, try converting code blocks to artifacts
      if (parseResult.artifacts.length === 0) {
        const convertedContent = convertCodeBlocksToArtifacts(allReplies);
        parseResult = parseArtifacts(convertedContent);
      }

      const { artifacts } = parseResult;

      if (artifacts.length === 0) {
        return;
      }

      perfLogger.log(`💾 [ARTIFACTS] Found ${artifacts.length} artifact(s) in completed quest ${quest.id}`);

      // Mark this quest as having its artifacts persisted
      persistedQuestsRef.current.add(quest.id);

      // Convert parsed artifacts to the format expected by persistArtifacts
      // Use quest ID to get consistent timestamp across all artifact generation
      const timestamp = getArtifactTimestamp(quest.id);
      const artifactsToPersist = artifacts.map((artifact, index) => {
        // Generate unique ID using shared utility function
        const uniqueId = generateCompleteArtifactId(artifact.type, artifact.identifier || '', timestamp, index);

        // Extract dependencies for React artifacts
        // any: artifact metadata shape varies per artifact type - react artifacts
        // get dependencies/hasDefaultExport/errorBoundary added below, others don't.
        const metadata: any = {
          operation: artifact.operation,
          language: artifact.language,
          questId: quest.id,
          originalIdentifier: artifact.identifier, // Preserve original identifier for reference
          createdAt: new Date().toISOString(),
        };

        // Add React-specific metadata
        if (artifact.type === 'react') {
          metadata.dependencies = extractReactDependencies(artifact.content);
          metadata.hasDefaultExport = checkHasDefaultExport(artifact.content);
          metadata.errorBoundary = true;
        }

        return {
          id: uniqueId,
          type: artifact.type,
          title: artifact.title,
          content: artifact.content,
          metadata,
        };
      });

      // Persist artifacts and store their IDs for UI access
      const questId = quest.id;
      persistArtifacts(artifactsToPersist, quest.sessionId)
        .then(() => {
          perfLogger.log(
            `✅ [ARTIFACTS] Successfully persisted ${artifactsToPersist.length} artifact(s) for quest ${questId}`
          );

          // Broadcast artifact IDs so UI can use complete IDs
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('artifacts-persisted', {
                detail: {
                  questId: questId,
                  artifacts: artifactsToPersist.map(a => ({
                    id: a.id,
                    type: a.type,
                    title: a.title,
                  })),
                },
              })
            );
          }
        })
        .catch(error => {
          console.error('Failed to persist artifacts:', error);
          perfLogger.error(`❌ [ARTIFACTS] Persistence failed for quest ${questId}:`, error);
          persistedQuestsRef.current.delete(questId);
        });
    },
    []
  );

  // Clear per-session dedup tracking when the subscription's session changes.
  const reset = useCallback(() => {
    persistedQuestsRef.current.clear();
  }, []);

  return useMemo(() => ({ persistArtifactsFromQuest, reset }), [persistArtifactsFromQuest, reset]);
}

import type { IFabFileDocument } from '@bike4mind/common';
import type { PendingMessageFile } from '@client/app/hooks/useSessionLayout';

/**
 * Represents a sortable item in the KnowledgeViewer
 */
export interface KnowledgeViewerItem {
  id: string;
  timestamp: number;
}

/**
 * Represents an artifact item with an id
 */
export interface ArtifactItem {
  id: string;
  [key: string]: any;
}

/**
 * Get stable timestamp for artifacts
 * Uses timestamp from artifact ID if available, otherwise uses character sum
 */
function getStableTimestamp(id: string): number {
  const parts = id.split('_');
  if (parts.length >= 4 && !isNaN(Number(parts[3]))) {
    return Number(parts[3]);
  }
  return id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
}

/**
 * Build a sorted list of knowledge items (files and artifacts) for the KnowledgeViewer.
 * Sorted by timestamp, newest first, for consistent ordering across the app.
 *
 * @param workBenchFiles - Session-level files in the workbench
 * @param systemFiles - System-level files (e.g., prompts)
 * @param messageFiles - Files attached to individual messages
 * @param pendingMessageFiles - Files being uploaded for messages (not yet sent)
 * @param recentArtifacts - Recent artifacts (code, diagrams, etc.)
 * @returns Sorted array of items with id and timestamp, newest first
 */
export function buildSortedKnowledgeItems(
  workBenchFiles: IFabFileDocument[],
  systemFiles: IFabFileDocument[],
  messageFiles: IFabFileDocument[],
  pendingMessageFiles: PendingMessageFile[],
  recentArtifacts: ArtifactItem[]
): KnowledgeViewerItem[] {
  const items: KnowledgeViewerItem[] = [];

  workBenchFiles.forEach(f => {
    items.push({
      id: f.id,
      timestamp: f.createdAt ? new Date(f.createdAt).getTime() : 0,
    });
  });

  // system- prefix distinguishes these from regular files
  systemFiles.forEach(f => {
    items.push({
      id: `system-${f.id}`,
      timestamp: f.createdAt ? new Date(f.createdAt).getTime() : 0,
    });
  });

  messageFiles.forEach(f => {
    items.push({
      id: f.id,
      timestamp: f.createdAt ? new Date(f.createdAt).getTime() : 0,
    });
  });

  // Completed pending files only, skipping ones already listed above
  const workBenchFileIds = new Set(workBenchFiles.map(f => f.id));
  const systemFileIds = new Set(systemFiles.map(f => f.id));
  const messageFileIds = new Set(messageFiles.map(f => f.id));

  pendingMessageFiles
    .filter(item => item.status === 'complete')
    .forEach(item => {
      if (
        !workBenchFileIds.has(item.fabFile.id) &&
        !systemFileIds.has(item.fabFile.id) &&
        !messageFileIds.has(item.fabFile.id)
      ) {
        items.push({
          id: item.fabFile.id,
          timestamp: item.fabFile.createdAt ? new Date(item.fabFile.createdAt).getTime() : Date.now(),
        });
      }
    });

  // Add artifacts with stable timestamps
  recentArtifacts.forEach(artifact => {
    const artifactTimestamp = getStableTimestamp(artifact.id);
    items.push({
      id: artifact.id,
      timestamp: artifactTimestamp,
    });
  });

  // Sort by timestamp (newest first) to match KnowledgeViewer
  items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  return items;
}

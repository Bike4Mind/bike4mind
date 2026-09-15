import { api } from '@client/app/contexts/ApiContext';
import { isQuotaExceededError } from './localStorageUtils';

// Track only active persistence operations
const activePersistenceOps = new Map<string, Promise<void>>();

// LocalStorage keys
const ARTIFACT_STORAGE_KEY = 'artifacts';
const ARTIFACT_VERSION_STORAGE_KEY = 'artifact_versions';

interface CachedArtifact {
  id: string;
  type: string;
  title: string;
  content: string;
  version?: number;
  metadata?: any;
  cachedAt: number;
}

interface CachedArtifactVersion {
  artifactId: string;
  version: number;
  content: string;
  cachedAt: number;
}

/**
 * Check if an artifact exists in the database
 */
export async function checkArtifactExists(artifactId: string): Promise<boolean> {
  try {
    const response = await api.get(`/api/artifacts/${artifactId}`);
    return response.status === 200;
  } catch (error: any) {
    if (error?.response?.status === 404) {
      return false;
    }
    console.warn(`Error checking artifact ${artifactId} existence:`, error);
    return false;
  }
}

/**
 * Persists an AI-generated artifact to the database
 * For React artifacts: creates v2+ versions when a new React artifact is generated in the same session
 * For other artifact types: always creates a new v1 artifact
 */
export async function persistArtifact(
  artifact: {
    id: string;
    type: string;
    title: string;
    content: string;
    metadata?: any;
  },
  sessionId?: string,
  skipExistenceCheck = false
): Promise<void> {
  // Check if already persisting this artifact
  const existingOp = activePersistenceOps.get(artifact.id);
  if (existingOp) {
    return existingOp;
  }

  const persistencePromise = (async () => {
    try {
      // Check if artifact already exists (skip for newly generated artifacts with unique IDs)
      if (!skipExistenceCheck) {
        const exists = await checkArtifactExists(artifact.id);
        if (exists) {
          return;
        }
      }

      // Check for existing React artifacts in the session to create versions
      // Only do this for React artifacts since they are typically iterated on
      let existingArtifactId: string | null = null;
      if (sessionId && artifact.type === 'react') {
        try {
          const response = await api.get(`/api/artifacts`, {
            params: {
              sessionId,
              type: 'react',
              sortBy: 'createdAt',
              sortOrder: 'desc',
              limit: 1, // Get the most recent React artifact
            },
          });

          const existingArtifacts = response.data?.artifacts || [];
          if (existingArtifacts.length > 0) {
            existingArtifactId = existingArtifacts[0].id;
            console.log(`📦 [ARTIFACTS] Found existing React artifact in session: ${existingArtifactId}`);
          }
        } catch (error) {
          console.warn('Failed to check for existing React artifacts:', error);
          // Continue with creating new artifact if check fails
        }
      }

      // If we found an existing React artifact, create a new version
      if (existingArtifactId) {
        try {
          console.log(`🔄 [ARTIFACTS] Creating v2+ version of ${existingArtifactId}`);

          // Ensure metadata includes all required fields, especially dependencies
          // The metadata should already have dependencies extracted, but make sure it's preserved
          const versionMetadata = {
            ...artifact.metadata, // This includes dependencies, hasDefaultExport, etc.
            aiGenerated: true,
            createdFrom: 'chat',
            versionNote: 'Updated from new prompt in session',
          };

          console.log(`📦 [ARTIFACTS] Version metadata:`, {
            dependencies: versionMetadata.dependencies,
            hasDefaultExport: versionMetadata.hasDefaultExport,
          });

          const updatePayload = {
            content: artifact.content,
            title: artifact.title,
            metadata: versionMetadata,
            createNewVersion: true,
            versionMessage: `Updated from new prompt: ${artifact.title}`,
          };

          await api.put(`/api/artifacts/${existingArtifactId}`, updatePayload);
          console.log(`✅ [ARTIFACTS] Successfully created new version of ${existingArtifactId}`);
          return;
        } catch (versionError: any) {
          console.warn(`Failed to create version, falling back to new artifact:`, versionError);
          // If version creation fails, continue to create new artifact
        }
      }

      // Create the artifact in the database with the original ID (v1)
      console.log(`📝 [ARTIFACTS] Creating new v1 artifact: ${artifact.id}`);
      // Link the artifact back to the quest that produced it. The quest id is
      // carried on artifact.metadata.questId (set in useSubscribeChatCompletion);
      // surface it as the top-level sourceQuestId field so the DB row is linked
      // for dedup/versioning and traceability instead of being undefined.
      const sourceQuestId = artifact.metadata?.questId as string | undefined;
      const createPayload = {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        description: `AI-generated ${artifact.type} component`,
        content: artifact.content,
        visibility: 'private' as const,
        tags: ['ai-generated'],
        sessionId: sessionId,
        ...(sourceQuestId ? { sourceQuestId } : {}),
        metadata: {
          ...artifact.metadata,
          aiGenerated: true,
          createdFrom: 'chat',
        },
      };

      await api.post('/api/artifacts', createPayload);
      console.log(`✅ [ARTIFACTS] Successfully created new v1 artifact: ${artifact.id}`);
    } catch (error: any) {
      console.error(`Failed to persist artifact ${artifact.id}:`, error);
      throw error;
    } finally {
      activePersistenceOps.delete(artifact.id);
    }
  })();

  activePersistenceOps.set(artifact.id, persistencePromise);
  await persistencePromise;
}

/**
 * Persists multiple artifacts from an AI response
 */
export async function persistArtifacts(
  artifacts: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
    metadata?: any;
  }>,
  sessionId?: string,
  skipExistenceCheck = true
): Promise<void> {
  const persistPromises = artifacts.map(artifact => persistArtifact(artifact, sessionId, skipExistenceCheck));
  await Promise.allSettled(persistPromises);
}

/**
 * Find existing artifact by querying the session's artifacts
 * This searches the database for artifacts matching the type and identifier
 */
export async function findExistingArtifactId(
  type: string,
  identifier: string,
  sessionId?: string
): Promise<string | null> {
  try {
    // Query artifacts by session and type
    if (!sessionId) {
      return null;
    }

    const response = await api.get(`/api/artifacts`, {
      params: {
        sessionId,
        type,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        limit: 50, // Get recent artifacts
      },
    });

    const artifacts = response.data?.artifacts || [];

    // Find the artifact that matches our identifier
    // The identifier is embedded in the artifact ID: artifact_{type}_{identifier}_{timestamp}_{index}
    const matchingArtifact = artifacts.find((artifact: any) => {
      const idParts = artifact.id.split('_');
      // artifact ID format: artifact_{type}_{identifier}_{timestamp}_{index}
      if (idParts.length >= 3) {
        const artifactIdentifier = idParts[2];
        return artifactIdentifier === identifier;
      }
      return false;
    });

    return matchingArtifact?.id || null;
  } catch (error) {
    console.warn('Error finding existing artifact:', error);
    return null;
  }
}

// LocalStorage functions

/**
 * Save artifact to localStorage with QuotaExceeded handling
 */
export function saveArtifactToLocalStorage(artifact: {
  id: string;
  type: string;
  title: string;
  content: string;
  version?: number;
  metadata?: any;
}): void {
  if (typeof window === 'undefined') return;

  const saveData = () => {
    const cached: CachedArtifact = {
      ...artifact,
      cachedAt: Date.now(),
    };

    const stored = localStorage.getItem(ARTIFACT_STORAGE_KEY);
    const artifacts: Record<string, CachedArtifact> = stored ? JSON.parse(stored) : {};
    artifacts[artifact.id] = cached;

    localStorage.setItem(ARTIFACT_STORAGE_KEY, JSON.stringify(artifacts));
  };

  try {
    saveData();
  } catch (error) {
    if (isQuotaExceededError(error)) {
      clearOldCachedArtifacts();
      try {
        saveData();
      } catch {
        console.error('[Artifacts] Cannot save artifact even after cleanup');
      }
    } else {
      console.error('Error saving artifact to localStorage:', error);
    }
  }
}

/**
 * Get artifact from localStorage
 */
export function getArtifactFromLocalStorage(artifactId: string): CachedArtifact | null {
  try {
    const stored = localStorage.getItem(ARTIFACT_STORAGE_KEY);
    if (!stored) return null;

    const artifacts: Record<string, CachedArtifact> = JSON.parse(stored);
    return artifacts[artifactId] || null;
  } catch (error) {
    console.error('Error reading artifact from localStorage:', error);
    return null;
  }
}

/**
 * Save artifact version to localStorage with QuotaExceeded handling
 */
export function saveArtifactVersionToLocalStorage(artifactId: string, version: number, content: string): void {
  if (typeof window === 'undefined') return;

  const saveData = () => {
    const cached: CachedArtifactVersion = {
      artifactId,
      version,
      content,
      cachedAt: Date.now(),
    };

    const versionKey = `${artifactId}_v${version}`;
    const stored = localStorage.getItem(ARTIFACT_VERSION_STORAGE_KEY);
    const versions: Record<string, CachedArtifactVersion> = stored ? JSON.parse(stored) : {};
    versions[versionKey] = cached;

    localStorage.setItem(ARTIFACT_VERSION_STORAGE_KEY, JSON.stringify(versions));
  };

  try {
    saveData();
  } catch (error) {
    if (isQuotaExceededError(error)) {
      clearOldCachedArtifacts();
      try {
        saveData();
      } catch {
        console.error('[Artifacts] Cannot save artifact version even after cleanup');
      }
    } else {
      console.error('Error saving artifact version to localStorage:', error);
    }
  }
}

/**
 * Get artifact version from localStorage
 */
export function getArtifactVersionFromLocalStorage(artifactId: string, version: number): CachedArtifactVersion | null {
  try {
    const versionKey = `${artifactId}_v${version}`;
    const stored = localStorage.getItem(ARTIFACT_VERSION_STORAGE_KEY);
    if (!stored) return null;

    const versions: Record<string, CachedArtifactVersion> = JSON.parse(stored);
    return versions[versionKey] || null;
  } catch (error) {
    console.error('Error reading artifact version from localStorage:', error);
    return null;
  }
}

/**
 * Clear old cached artifacts (older than 7 days)
 */
export function clearOldCachedArtifacts(): void {
  try {
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    const now = Date.now();

    // Clear old artifacts
    const artifactsStored = localStorage.getItem(ARTIFACT_STORAGE_KEY);
    if (artifactsStored) {
      const artifacts: Record<string, CachedArtifact> = JSON.parse(artifactsStored);
      const filtered = Object.fromEntries(
        Object.entries(artifacts).filter(([_, artifact]) => now - artifact.cachedAt < maxAge)
      );
      localStorage.setItem(ARTIFACT_STORAGE_KEY, JSON.stringify(filtered));
    }

    // Clear old versions
    const versionsStored = localStorage.getItem(ARTIFACT_VERSION_STORAGE_KEY);
    if (versionsStored) {
      const versions: Record<string, CachedArtifactVersion> = JSON.parse(versionsStored);
      const filtered = Object.fromEntries(
        Object.entries(versions).filter(([_, version]) => now - version.cachedAt < maxAge)
      );
      localStorage.setItem(ARTIFACT_VERSION_STORAGE_KEY, JSON.stringify(filtered));
    }
  } catch (error) {
    console.error('Error clearing old cached artifacts:', error);
  }
}

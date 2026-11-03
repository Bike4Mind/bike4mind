import { api } from '@client/app/contexts/ApiContext';
import { isQuotaExceededError } from './localStorageUtils';

// Track only active persistence operations
const activePersistenceOps = new Map<string, Promise<void>>();
// Whole persistArtifacts calls, including blocks still queued behind an earlier one.
const activePersistenceBatches = new Set<Promise<unknown>>();

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

interface PersistableArtifact {
  id: string;
  type: string;
  title: string;
  content: string;
  /** The reply's `<artifact identifier=...>`, stored on the row and used to find it again. */
  identifier?: string;
  metadata?: any;
}

/**
 * The newest session row of `type` carrying `identifier`, or null. The server also matches rows
 * written before `identifier` was a field through their `metadata.originalIdentifier`.
 */
async function findArtifactIdByIdentifier(type: string, identifier: string, sessionId: string): Promise<string | null> {
  const response = await api.get(`/api/artifacts`, {
    params: { sessionId, type, identifier, sortBy: 'createdAt', sortOrder: 'desc', limit: 1 },
  });
  return response.data?.artifacts?.[0]?.id ?? null;
}

/**
 * Persists an AI-generated artifact to the database
 * For React artifacts: a new version of the session's React row with the same identifier, if any
 * For everything else (and React without an identifier): always creates a new v1 artifact
 */
export async function persistArtifact(
  artifact: PersistableArtifact,
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

      // Only React artifacts are iterated on as versions, and only under the same identifier: any
      // other React artifact in the session is a different component, not an earlier version.
      let existingArtifactId: string | null = null;
      if (sessionId && artifact.type === 'react' && artifact.identifier) {
        try {
          existingArtifactId = await findExistingArtifactId('react', artifact.identifier, sessionId);
          if (existingArtifactId) {
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
        ...(artifact.identifier ? { identifier: artifact.identifier } : {}),
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
 * Persists multiple artifacts from an AI response, given in document order.
 *
 * Artifacts sharing an identifier persist one after another, in that order, so a later block
 * versions the row an earlier one created instead of racing it to the lookup. The rest run in
 * parallel.
 */
export async function persistArtifacts(
  artifacts: PersistableArtifact[],
  sessionId?: string,
  skipExistenceCheck = true
): Promise<void> {
  const chains = new Map<string, Promise<void>>();
  const persistPromises = artifacts.map(artifact => {
    const persist = () => persistArtifact(artifact, sessionId, skipExistenceCheck);
    if (!artifact.identifier) {
      return persist();
    }
    const previous = chains.get(artifact.identifier) ?? Promise.resolve();
    // Runs even when the earlier block failed; it then creates the row itself.
    const next = previous.then(persist, persist);
    chains.set(artifact.identifier, next);
    return next;
  });
  const batch = Promise.allSettled(persistPromises);
  activePersistenceBatches.add(batch);
  try {
    await batch;
  } finally {
    activePersistenceBatches.delete(batch);
  }
}

/**
 * Find the session's artifact for a reply's `type` + `identifier`, newest first.
 */
export async function findExistingArtifactId(
  type: string,
  identifier: string,
  sessionId?: string
): Promise<string | null> {
  try {
    if (!sessionId || !identifier) {
      return null;
    }

    const byIdentifier = await findArtifactIdByIdentifier(type, identifier, sessionId);
    if (byIdentifier) {
      return byIdentifier;
    }

    // A legacy row with neither the field nor metadata.originalIdentifier carries the identifier
    // only as an id segment.
    const response = await api.get(`/api/artifacts`, {
      params: {
        sessionId,
        type,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        limit: 50, // Get recent artifacts
      },
    });

    const artifacts: unknown[] = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];

    // Find the artifact that matches our identifier
    // The identifier is embedded in the artifact ID: artifact_{type}_{identifier}_{timestamp}_{index}
    const matchingArtifact = artifacts.find((artifact): artifact is { id: string } => {
      if (typeof artifact !== 'object' || artifact === null || !('id' in artifact) || typeof artifact.id !== 'string') {
        return false;
      }
      if ('identifier' in artifact && artifact.identifier !== undefined) return false;
      const metadata = 'metadata' in artifact ? artifact.metadata : undefined;
      if (
        typeof metadata === 'object' &&
        metadata !== null &&
        'originalIdentifier' in metadata &&
        metadata.originalIdentifier !== undefined
      ) {
        return false;
      }
      const prefix = `artifact_${type}_`;
      if (!artifact.id.startsWith(prefix)) return false;
      const artifactIdentifier = /^(.+)_\d+_\d+$/.exec(artifact.id.slice(prefix.length))?.[1];
      return artifactIdentifier === identifier;
    });

    return matchingArtifact?.id || null;
  } catch (error) {
    console.warn('Error finding existing artifact:', error);
    return null;
  }
}

/**
 * The row a save of `artifactId` belongs on after a PUT to that id found nothing, or null when
 * the session has none and the caller should create it. A card's id can name no row: it was
 * minted before the reply was saved, or restored from a stale layout. Its identifier still names
 * the session's row, and creating one under the dead id would leave a duplicate beside it.
 */
export async function findArtifactSaveTarget(
  artifactId: string,
  type: string,
  sessionId?: string
): Promise<string | null> {
  // A save right after a reply finishes can beat that reply's own persist to the server.
  const inFlight = [...activePersistenceBatches, ...activePersistenceOps.values()];
  if (inFlight.length > 0) {
    await Promise.allSettled(inFlight);
    if (await checkArtifactExists(artifactId)) return artifactId;
  }
  // Minted as artifact_{type}_{identifier}_{timestamp}_{index}; the identifier may itself hold `_`.
  const prefix = `artifact_${type}_`;
  const identifier = artifactId.startsWith(prefix)
    ? /^(.+)_\d+_\d+$/.exec(artifactId.slice(prefix.length))?.[1]
    : undefined;
  return identifier ? findExistingArtifactId(type, identifier, sessionId) : null;
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

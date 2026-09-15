/**
 * Utility to manage mapping between legacy artifact IDs and Quest 4 artifact IDs
 * This is stored in localStorage to persist across page reloads
 */

const ARTIFACT_ID_MAP_KEY = 'artifact-id-mappings';

export interface ArtifactIdMapping {
  legacyId: string;
  quest4Id: string;
  updatedAt: number;
}

/**
 * Get all artifact ID mappings from localStorage
 */
export function getArtifactIdMappings(): Record<string, ArtifactIdMapping> {
  try {
    const stored = localStorage.getItem(ARTIFACT_ID_MAP_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch (error) {
    console.error('Error reading artifact ID mappings:', error);
    return {};
  }
}

/**
 * Save a mapping between a legacy ID and Quest 4 ID
 */
export function saveArtifactIdMapping(legacyId: string, quest4Id: string): void {
  try {
    // Validate that quest4Id is a complete Quest 4 artifact ID
    const isCompleteQuest4Id = quest4Id.startsWith('artifact_') && quest4Id.split('_').length >= 5;

    if (!isCompleteQuest4Id) {
      console.warn(`⚠️ Attempted to save incomplete Quest 4 ID mapping: ${legacyId} -> ${quest4Id}`);
      return;
    }

    // Don't create self-referencing mappings
    if (legacyId === quest4Id) {
      console.warn(`⚠️ Attempted to save self-referencing mapping: ${legacyId}`);
      return;
    }

    const mappings = getArtifactIdMappings();
    mappings[legacyId] = {
      legacyId,
      quest4Id,
      updatedAt: Date.now(),
    };
    localStorage.setItem(ARTIFACT_ID_MAP_KEY, JSON.stringify(mappings));
  } catch (error) {
    console.error('Error saving artifact ID mapping:', error);
  }
}

/**
 * Get the Quest 4 ID for a legacy ID, if it exists
 */
export function getQuest4IdForLegacy(legacyId: string): string | null {
  const mappings = getArtifactIdMappings();
  const mapping = mappings[legacyId];

  if (mapping) {
    // Validate the mapped ID is actually complete
    const isCompleteQuest4Id = mapping.quest4Id.startsWith('artifact_') && mapping.quest4Id.split('_').length >= 5;

    if (!isCompleteQuest4Id) {
      console.warn(`⚠️ Found invalid Quest 4 ID mapping for ${legacyId}: ${mapping.quest4Id} - removing`);
      removeArtifactIdMapping(legacyId);
      return null;
    }

    return mapping.quest4Id;
  }

  return null;
}

/**
 * Remove a mapping (e.g., when an artifact is deleted)
 */
export function removeArtifactIdMapping(legacyId: string): void {
  try {
    const mappings = getArtifactIdMappings();
    delete mappings[legacyId];
    localStorage.setItem(ARTIFACT_ID_MAP_KEY, JSON.stringify(mappings));
  } catch (error) {
    console.error('Error removing artifact ID mapping:', error);
  }
}

/**
 * Clear all artifact ID mappings (useful for debugging)
 */
export function clearAllArtifactIdMappings(): void {
  try {
    localStorage.removeItem(ARTIFACT_ID_MAP_KEY);
  } catch (error) {
    console.error('Error clearing artifact ID mappings:', error);
  }
}

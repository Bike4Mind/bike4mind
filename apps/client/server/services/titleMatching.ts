/**
 * Shared Title Matching Utilities
 *
 * Provides Jaro-Winkler similarity matching for GitHub issue titles.
 * Used as a fallback when fingerprints don't match but titles are semantically similar.
 * Extracted from liveopsFingerprint.ts for sharing between LiveOps and Telemetry systems.
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * Issue type for title matching
 */
export interface TitleMatchIssue {
  number: number;
  title: string;
  state: string;
  closedAt?: string;
}

/**
 * Options for title matching
 */
export interface TitleMatchOptions {
  /** Minimum similarity score to consider a match (default 0.90) */
  threshold?: number;
  /** Minimum normalized title length to attempt matching (default 40) */
  minLength?: number;
}

/**
 * Result of title matching
 */
export interface TitleMatchResult {
  issue: TitleMatchIssue;
  similarity: number;
}

// ============================================================================
// TITLE NORMALIZATION
// ============================================================================

/**
 * Normalize a title for comparison by:
 * - Lowercasing
 * - Removing common prefixes ([LiveOps], [Telemetry], [Auto-Telemetry])
 * - Removing variable parts (counts, timestamps, scores)
 * - Collapsing whitespace
 *
 * @param title - The title to normalize
 * @returns Normalized title for comparison
 */
export function normalizeTitle(title: string): string {
  return (
    title
      .toLowerCase()
      // Remove common automated issue prefixes
      .replace(/^\[liveops\]\s*/i, '')
      .replace(/^\[telemetry\]\s*/i, '')
      .replace(/^\[auto-telemetry\]\s*/i, '')
      // Remove emoji prefixes (severity indicators)
      .replace(/^[\u{1F534}\u{1F7E0}\u{1F7E1}\u{1F7E2}]\s*/u, '')
      // Remove variable counts/occurrences
      .replace(/\d+ (occurrences?|times?|errors?)/gi, '<COUNT>')
      // Remove scores like (score: 50)
      .replace(/\(score:\s*\d+\)/gi, '<SCORE>')
      // Remove dates
      .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ============================================================================
// JARO-WINKLER SIMILARITY
// ============================================================================

/**
 * Calculate Jaro similarity between two strings.
 * Core component of Jaro-Winkler algorithm.
 *
 * @param s1 - First string
 * @param s2 - Second string
 * @returns Similarity score between 0 and 1
 */
function jaroSimilarity(s1: string, s2: string): number {
  // Handle empty strings (defensive: empty strings should return 0, not 1)
  if (!s1.length || !s2.length) return 0;
  if (s1 === s2) return 1;

  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    // Defensive bounds check for k index
    while (k < s2.length && !s2Matches[k]) k++;
    if (k < s2.length && s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;
}

/**
 * Calculate Jaro-Winkler similarity score (0-1, where 1 is exact match).
 *
 * Better than Levenshtein for error titles due to:
 * - O(n+m) complexity vs O(n*m)
 * - Better prefix matching (error titles share common prefixes like "TypeError:", "MongoError:", etc.)
 *
 * @param s1 - First string
 * @param s2 - Second string
 * @param prefixScale - Scaling factor for common prefix bonus (default 0.1, max 0.25)
 * @returns Similarity score between 0 and 1
 */
export function jaroWinklerSimilarity(s1: string, s2: string, prefixScale: number = 0.1): number {
  const jaroSim = jaroSimilarity(s1, s2);

  // Find common prefix (up to 4 characters)
  let prefixLength = 0;
  const maxPrefixLength = Math.min(4, Math.min(s1.length, s2.length));
  for (let i = 0; i < maxPrefixLength; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  // Apply Winkler modification
  return jaroSim + prefixLength * prefixScale * (1 - jaroSim);
}

/**
 * Calculate title similarity score using Jaro-Winkler on normalized titles.
 *
 * @param title1 - First title
 * @param title2 - Second title
 * @returns Similarity score between 0 and 1
 */
export function calculateTitleSimilarity(title1: string, title2: string): number {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);

  if (norm1 === norm2) return 1;
  if (!norm1 || !norm2) return 0;

  return jaroWinklerSimilarity(norm1, norm2);
}

// ============================================================================
// TITLE MATCHING
// ============================================================================

/**
 * Find the best matching issue by title similarity.
 *
 * @param proposedTitle - The title proposed for a new issue
 * @param existingIssues - List of existing issues to check against
 * @param options - Matching options (threshold, minLength)
 * @returns The best matching issue if above threshold, null otherwise
 */
export function findBestTitleMatch(
  proposedTitle: string,
  existingIssues: TitleMatchIssue[],
  options: TitleMatchOptions = {}
): TitleMatchResult | null {
  const { threshold = 0.9, minLength = 40 } = options;

  const normalizedProposed = normalizeTitle(proposedTitle);

  // Skip if title is too short (high false positive risk)
  if (normalizedProposed.length < minLength) {
    return null;
  }

  let bestMatch: TitleMatchResult | null = null;

  for (const issue of existingIssues) {
    const similarity = calculateTitleSimilarity(proposedTitle, issue.title);

    if (similarity >= threshold && (!bestMatch || similarity > bestMatch.similarity)) {
      bestMatch = { issue, similarity };
    }
  }

  return bestMatch;
}

/**
 * Shared Issue Deduplication Utilities
 *
 * Provides common deduplication and regression detection logic for GitHub issues.
 * Used by both LiveOps Triage and Context Telemetry systems.
 */

// Types

/**
 * Issue structure for deduplication checks.
 * Contains the minimum fields needed for fingerprint matching.
 */
export interface IssueForDedup {
  number: number;
  title: string;
  state: string;
  body: string | null;
  closedAt: string | null;
  fingerprint: string | null;
  semanticFingerprint: string | null;
}

/**
 * Result of deduplication check.
 */
export interface DeduplicationResult {
  /** Whether this is a duplicate of an existing open issue */
  isDuplicate: boolean;
  /** The matched open issue (if duplicate) */
  matchedIssue?: IssueForDedup;
  /** Whether this is a regression (reoccurrence of a closed issue) */
  isRegression: boolean;
  /** The matched closed issue (if regression) */
  matchedClosedIssue?: IssueForDedup;
}

// Fingerprint-based deduplication

/**
 * Check for fingerprint matches against existing issues.
 *
 * Logic:
 * 1. Exact fingerprint match on open issue -> duplicate (no new issue)
 * 2. Semantic fingerprint match on open issue -> duplicate (no new issue)
 * 3. Fingerprint match on closed issue:
 *    - Within regression grace period -> duplicate (no new issue)
 *    - Beyond regression grace period -> regression (create new issue with regression label)
 *
 * @param fingerprint - The exact fingerprint to match
 * @param semanticFingerprint - The semantic fingerprint for looser matching (may be null)
 * @param openIssues - List of open issues with extracted fingerprints
 * @param closedIssues - List of recently closed issues with extracted fingerprints
 * @param gracePeriodHours - Hours after closure before same fingerprint is considered regression
 * @returns Deduplication result indicating duplicate/regression status
 */
export function checkFingerprintDedup(
  fingerprint: string,
  semanticFingerprint: string | null,
  openIssues: IssueForDedup[],
  closedIssues: IssueForDedup[],
  gracePeriodHours: number
): DeduplicationResult {
  // 1. Check exact fingerprint match on open issues
  const exactOpenMatch = openIssues.find(issue => issue.fingerprint === fingerprint);
  if (exactOpenMatch) {
    return {
      isDuplicate: true,
      matchedIssue: exactOpenMatch,
      isRegression: false,
    };
  }

  // 2. Check semantic fingerprint match on open issues (if provided)
  if (semanticFingerprint) {
    const semanticOpenMatch = openIssues.find(issue => issue.semanticFingerprint === semanticFingerprint);
    if (semanticOpenMatch) {
      return {
        isDuplicate: true,
        matchedIssue: semanticOpenMatch,
        isRegression: false,
      };
    }
  }

  // 3. Check fingerprint match on closed issues
  const closedMatch = closedIssues.find(issue => issue.fingerprint === fingerprint);
  if (closedMatch) {
    // Check if within grace period
    if (isWithinGracePeriod(closedMatch, gracePeriodHours)) {
      // Within grace period = treat as duplicate (don't create new issue)
      return {
        isDuplicate: true,
        matchedIssue: closedMatch,
        isRegression: false,
      };
    } else {
      // Beyond grace period = regression
      return {
        isDuplicate: false,
        isRegression: true,
        matchedClosedIssue: closedMatch,
      };
    }
  }

  // 4. Check semantic fingerprint match on closed issues (if provided)
  if (semanticFingerprint) {
    const semanticClosedMatch = closedIssues.find(issue => issue.semanticFingerprint === semanticFingerprint);
    if (semanticClosedMatch) {
      if (isWithinGracePeriod(semanticClosedMatch, gracePeriodHours)) {
        return {
          isDuplicate: true,
          matchedIssue: semanticClosedMatch,
          isRegression: false,
        };
      } else {
        return {
          isDuplicate: false,
          isRegression: true,
          matchedClosedIssue: semanticClosedMatch,
        };
      }
    }
  }

  // No match found
  return {
    isDuplicate: false,
    isRegression: false,
  };
}

// Regression detection

/**
 * Check if an issue is within the regression grace period.
 *
 * Issues closed within the grace period should not trigger regression detection,
 * as the alert may be from a delayed log/event that occurred before the fix.
 *
 * @param closedIssue - The closed issue to check
 * @param gracePeriodHours - Grace period in hours
 * @returns true if the issue is within the grace period
 */
export function isWithinGracePeriod(closedIssue: IssueForDedup, gracePeriodHours: number): boolean {
  if (!closedIssue.closedAt) {
    return false;
  }

  const closedAt = new Date(closedIssue.closedAt).getTime();
  const gracePeriodMs = gracePeriodHours * 60 * 60 * 1000;
  const now = Date.now();

  return now - closedAt <= gracePeriodMs;
}

/**
 * Check if a closed issue should be marked as regression.
 *
 * A regression is when:
 * 1. The issue was closed (bug was fixed)
 * 2. The same error reoccurs (matching fingerprint)
 * 3. Enough time has passed since closure (beyond grace period)
 *
 * @param closedIssue - The closed issue to check
 * @param gracePeriodHours - Grace period in hours
 * @returns true if the issue is a regression candidate
 */
export function isRegressionCandidate(closedIssue: IssueForDedup, gracePeriodHours: number): boolean {
  if (!closedIssue.closedAt) {
    return false;
  }

  return !isWithinGracePeriod(closedIssue, gracePeriodHours);
}

/**
 * Check if LLM-matched closed issue should be marked as regression.
 *
 * This handles cases where:
 * 1. LLM matched the alert to a closed issue by semantic understanding
 * 2. The closed issue doesn't have an embedded fingerprint (legacy issue)
 * 3. We need to determine if this is a regression or just a delayed alert
 *
 * Extracted from liveopsTriageService.checkLLMMatchedClosedIssueRegression()
 *
 * @param matchedIssueNumber - The issue number matched by LLM
 * @param recentlyClosedIssues - List of recently closed issues
 * @param gracePeriodHours - Grace period in hours
 * @returns Object with isRegression flag and matched issue details
 */
export function checkLLMMatchedClosedIssueRegression(
  matchedIssueNumber: number,
  recentlyClosedIssues: IssueForDedup[],
  gracePeriodHours: number
): { isRegression: boolean; matchedClosedIssue?: IssueForDedup } {
  const llmMatchedClosedIssue = recentlyClosedIssues.find(i => i.number === matchedIssueNumber);

  if (!llmMatchedClosedIssue || !llmMatchedClosedIssue.closedAt) {
    return { isRegression: false };
  }

  if (isRegressionCandidate(llmMatchedClosedIssue, gracePeriodHours)) {
    return {
      isRegression: true,
      matchedClosedIssue: llmMatchedClosedIssue,
    };
  }

  return { isRegression: false };
}

// Issue enrichment helpers

/**
 * Extract fingerprints from issue body and enrich the issue object.
 *
 * @param issue - The issue to enrich
 * @param extractFn - Function to extract fingerprint from body
 * @param extractSemanticFn - Function to extract semantic fingerprint from body
 * @returns Issue with fingerprint and semanticFingerprint fields populated
 */
export function enrichIssueWithFingerprints<T extends { body: string | null }>(
  issue: T,
  extractFn: (body: string | null) => string | null,
  extractSemanticFn: (body: string | null) => string | null
): T & { fingerprint: string | null; semanticFingerprint: string | null } {
  return {
    ...issue,
    fingerprint: extractFn(issue.body),
    semanticFingerprint: extractSemanticFn(issue.body),
  };
}

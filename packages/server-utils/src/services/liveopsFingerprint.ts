/**
 * LiveOps Fingerprinting Utility
 *
 * Provides deterministic error fingerprinting for deduplication, following
 * industry best practices from Sentry, Rollbar, and Bugsnag.
 *
 * Key design decisions:
 * - SHA-1 hash (40 chars) - Rollbar standard
 * - Exclude line numbers - they change with unrelated code changes
 * - Function name + filename only - more stable across deployments
 * - Conservative normalization - avoid false positives
 */

import { createHash } from 'crypto';
import type { SlackAlert } from './liveopsTriageService';

/**
 * Regex patterns for extracting and normalizing error data
 */
const PATTERNS = {
  // Error type extraction (e.g., "TypeError:", "MongoServerError:", "ValidationException:")
  errorType: /^(?:(?:Runtime\.)?UnhandledPromiseRejection:\s*)?(\w+(?:Error|Exception)?)\s*:/m,

  // Stack frame extraction - captures function name and file path (NOT line numbers per Rollbar)
  // Matches: "    at FunctionName (filepath:123:45)" or "    at filepath:123:45"
  // Requires stack frames to start with whitespace + "at " to avoid false matches
  // Also matches "at FunctionName (node:internal/...)" style
  stackFrame:
    /(?:^|\n)\s+at\s+(?:(?:async\s+)?(\S+)\s+\()?((?:node:[^\s:)]+|\/[^:\s()]+|[a-zA-Z]:[^:\s()]+))(?::\d+)?(?::\d+)?\)?/gm,

  // Normalization patterns
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  mongoObjectId: /\b[0-9a-f]{24}\b/gi,
  isoTimestamp: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?/g,
  unixTimestamp: /\b\d{10,13}\b/g,
  slackTimestamp: /\d{10}\.\d{6}/g,
  portNumber: /:(\d{4,5})\b/g,
  requestId: /(?:request[_-]?id|correlation[_-]?id|trace[_-]?id|req_id|x-request-id)[:\s=]+['"]?[\w-]+['"]?/gi,
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  ipv6: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b/g,

  // AWS/CloudWatch patterns (for LiveOps alert deduplication)
  // CloudWatch console URLs - entire URL is variable (handles log streams, function suffixes, etc.)
  cloudwatchUrl: /https:\/\/console\.aws\.amazon\.com\/cloudwatch\/[^\s)]+/gi,
  // 32-character hex IDs (AWS log stream IDs, X-Ray segments - not matched by 24-char ObjectId)
  hexId32: /\b[0-9a-f]{32}\b/gi,
  // Count/duration metadata that appears in aggregated alerts
  countDuration: /count:\s*\d+\s+duration:\s*[\dhms\s]+/gi,
  // Lambda log stream format: YYYY/MM/DD/[$LATEST]hexstring or YYYY/MM/DD/[version]hexstring
  lambdaLogStream: /\d{4}\/\d{2}\/\d{2}\/\[\$?\w+\][a-f0-9]{32}/gi,
};

/**
 * Frames to exclude from fingerprinting (external/runtime frames)
 */
const EXCLUDED_FRAME_PATTERNS = [
  /^node:/, // node:internal/*, node:fs, etc.
  /node_modules/,
  /internal\/deps/,
  /^<anonymous>$/,
  /^\[native code\]$/,
  /^native /,
];

/**
 * Check if a file path should be excluded from fingerprinting
 */
function isExcludedFrame(filePath: string, functionName?: string): boolean {
  for (const pattern of EXCLUDED_FRAME_PATTERNS) {
    if (pattern.test(filePath)) {
      return true;
    }
  }

  if (functionName) {
    for (const pattern of EXCLUDED_FRAME_PATTERNS) {
      if (pattern.test(functionName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract the error type/class from error text
 *
 * @example
 * extractErrorType("TypeError: Cannot read property 'foo'") => "TypeError"
 * extractErrorType("MongoServerError: E11000 duplicate key") => "MongoServerError"
 */
export function extractErrorType(text: string): string {
  const match = text.match(PATTERNS.errorType);
  if (match?.[1]) {
    return match[1];
  }

  // Fallback: look for common error patterns
  const errorPatterns = [
    /\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\b/,
    /\b(MongoServerError|MongoNetworkError|MongoError)\b/,
    /\b(ValidationException|ServiceException|AccessDeniedException)\b/,
    /\b(\w+Error|\w+Exception)\b/,
  ];

  for (const pattern of errorPatterns) {
    const fallbackMatch = text.match(pattern);
    if (fallbackMatch?.[1]) {
      return fallbackMatch[1];
    }
  }

  return 'UnknownError';
}

/**
 * Extract stack trace signature from error text
 *
 * Returns a normalized string of function names + filenames (NO line numbers)
 * Only includes application frames, excludes node internals and node_modules
 *
 * @example
 * Input: "at Fetch.onAborted (node:internal/deps/undici:11322:53)"
 * Output: "" (excluded - internal frame)
 *
 * Input: "at processError (/app/src/handler.js:45:12)"
 * Output: "processError@handler.js"
 */
export function extractStackSignature(text: string): string {
  const frames: string[] = [];

  // Reset regex lastIndex
  PATTERNS.stackFrame.lastIndex = 0;

  let match;
  while ((match = PATTERNS.stackFrame.exec(text)) !== null) {
    const [, functionName, filePath] = match;

    // Skip excluded frames (node internals, node_modules, etc.)
    if (isExcludedFrame(filePath, functionName)) {
      continue;
    }

    // Extract just the filename from the path
    const filename = filePath.split('/').pop() || filePath;

    // Build frame signature: "functionName@filename" or just "filename"
    const frameSignature = functionName ? `${functionName}@${filename}` : filename;

    frames.push(frameSignature);
  }

  // Sort so the same frames in a different order produce the same signature.
  return frames.sort().join('|');
}

/**
 * Normalize error message by replacing variable parts with placeholders
 *
 * Conservative normalization to avoid false positives:
 * - Replaces: UUIDs, ObjectIds, timestamps, ports, request IDs, emails, IPs
 * - Preserves: file paths, HTTP status codes, error codes, model names
 */
export function normalizeErrorMessage(text: string): string {
  let normalized = text;

  // Order matters: more specific patterns first

  // Remove Runtime.UnhandledPromiseRejection wrapper (common Lambda prefix)
  normalized = normalized.replace(/^Runtime\.UnhandledPromiseRejection:\s*/i, '');

  // AWS/CloudWatch patterns (replace FIRST to handle embedded IDs and suffixes)
  normalized = normalized.replace(PATTERNS.cloudwatchUrl, '<CLOUDWATCH_URL>');
  normalized = normalized.replace(PATTERNS.lambdaLogStream, '<LOG_STREAM>');
  // Replace 32-char hex IDs (after URLs to avoid partial matches)
  normalized = normalized.replace(PATTERNS.hexId32, '<HEX_ID>');
  normalized = normalized.replace(PATTERNS.countDuration, '<COUNT_DURATION>');

  // Replace ISO timestamps (YYYY-MM-DDTHH:MM:SS format)
  normalized = normalized.replace(PATTERNS.isoTimestamp, '<TIMESTAMP>');

  // Replace Slack timestamps (before general numbers) - format: 10digits.6digits
  normalized = normalized.replace(PATTERNS.slackTimestamp, '<SLACK_TS>');

  // Replace UUIDs (also covers AWS request IDs)
  normalized = normalized.replace(PATTERNS.uuid, '<UUID>');

  // Replace MongoDB ObjectIds (24 hex chars)
  normalized = normalized.replace(PATTERNS.mongoObjectId, '<ID>');

  // Replace Unix timestamps (10-13 digits standalone)
  // But avoid matching things like port numbers or small integers
  normalized = normalized.replace(/\b[12]\d{9,12}\b/g, '<TS>');

  normalized = normalized.replace(PATTERNS.portNumber, ':<PORT>');
  normalized = normalized.replace(PATTERNS.requestId, '<REQ_ID>');
  normalized = normalized.replace(PATTERNS.email, '<EMAIL>');
  normalized = normalized.replace(PATTERNS.ipv4, '<IP>');
  normalized = normalized.replace(PATTERNS.ipv6, '<IP>');

  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

/**
 * Generate SHA-1 hash (40 chars) of the input string
 */
function sha1Hash(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Generate a full fingerprint using error type + stack signature + normalized message
 * This is the primary fingerprinting method (Tier 1)
 */
function generateFullFingerprint(alert: SlackAlert): string | null {
  const errorType = extractErrorType(alert.text);
  const stackSignature = extractStackSignature(alert.text);
  const normalizedMessage = normalizeErrorMessage(alert.text);

  // Require at least error type and some meaningful content
  if (errorType === 'UnknownError' && !stackSignature && normalizedMessage.length < 20) {
    return null;
  }

  const fingerprintSource = `${errorType}::${stackSignature}::${normalizedMessage}`;
  return sha1Hash(fingerprintSource);
}

/**
 * Generate a partial fingerprint using error type + normalized message only
 * Used when no stack trace is available (Tier 2)
 */
function generatePartialFingerprint(alert: SlackAlert): string | null {
  const errorType = extractErrorType(alert.text);
  const normalizedMessage = normalizeErrorMessage(alert.text);

  // Require meaningful content
  if (normalizedMessage.length < 20) {
    return null;
  }

  const fingerprintSource = `partial::${errorType}::${normalizedMessage}`;
  return sha1Hash(fingerprintSource);
}

/**
 * Generate a fallback fingerprint using the entire normalized message
 * Used as a last resort (Tier 3)
 */
function generateFallbackFingerprint(alert: SlackAlert): string | null {
  const normalizedMessage = normalizeErrorMessage(alert.text);

  // Require some content
  if (normalizedMessage.length < 10) {
    return null;
  }

  const fingerprintSource = `fallback::${normalizedMessage}`;
  return sha1Hash(fingerprintSource);
}

/**
 * Generate a fingerprint for an alert using tiered approach
 *
 * Tier 1: Full fingerprint (error type + stack + message)
 * Tier 2: Partial fingerprint (error type + message only)
 * Tier 3: Fallback fingerprint (entire normalized message)
 *
 * @returns SHA-1 hash (40 chars) or null if fingerprinting fails
 */
export function generateFingerprint(alert: SlackAlert): string | null {
  // Tier 1: Full fingerprint
  const fullFp = generateFullFingerprint(alert);
  if (fullFp) return fullFp;

  // Tier 2: Partial fingerprint
  const partialFp = generatePartialFingerprint(alert);
  if (partialFp) return partialFp;

  // Tier 3: Fallback fingerprint
  return generateFallbackFingerprint(alert);
}

/**
 * Generate a fingerprint from a GitHub issue body. Used for backfilling
 * fingerprints on LiveOps issues created before fingerprinting existed.
 *
 * @param body - The GitHub issue body text containing error details
 * @returns SHA-1 fingerprint (40 chars) or null if body is empty/invalid
 */
export function generateFingerprintFromIssueBody(body: string | undefined | null): string | null {
  if (!body) return null;

  // Create a synthetic alert from the issue body
  const syntheticAlert: SlackAlert = {
    ts: '',
    text: body,
    timestamp: new Date(),
  };

  return generateFingerprint(syntheticAlert);
}

/**
 * Extract fingerprint from an issue body that already has one
 */
export function extractFingerprintFromIssueBody(body: string | undefined | null): string | null {
  if (!body) return null;

  // Match the fingerprint HTML comment
  const match = body.match(/<!-- fingerprint:([a-f0-9]{40}) -->/i);
  return match?.[1] || null;
}

/**
 * Generate the fingerprint HTML comment for embedding in issue body
 */
export function formatFingerprintComment(fingerprint: string): string {
  return `<!-- fingerprint:${fingerprint} -->`;
}

/**
 * Generate the semantic fingerprint HTML comment for embedding in issue body
 * Semantic fingerprints are more aggressive at normalizing variable content
 */
export function formatSemanticFingerprintComment(semanticFingerprint: string): string {
  return `<!-- semantic-fingerprint:${semanticFingerprint} -->`;
}

/**
 * Extract semantic fingerprint from GitHub issue body
 * @param body - The GitHub issue body text
 * @returns SHA-1 semantic fingerprint (40 chars) or null if not found
 */
export function extractSemanticFingerprintFromIssueBody(body: string | undefined | null): string | null {
  if (!body) return null;

  // Match the semantic fingerprint HTML comment
  const match = body.match(/<!-- semantic-fingerprint:([a-f0-9]{40}) -->/i);
  return match?.[1] || null;
}

// Title-based matching: fallback when fingerprints differ but titles are semantically similar.

/**
 * Normalize a title for comparison by:
 * - Lowercasing
 * - Removing [LiveOps] prefix
 * - Removing common variable parts (counts, timestamps)
 * - Collapsing whitespace
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\[liveops\]\s*/i, '')
    .replace(/\d+ (occurrences?|times?|errors?)/gi, '<COUNT>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate Jaro similarity between two strings
 * Core component of Jaro-Winkler algorithm
 */
function jaroSimilarity(s1: string, s2: string): number {
  // Handle empty strings first (defensive: empty strings should return 0, not 1)
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
 * Calculate Jaro-Winkler similarity score (0-1, where 1 is exact match)
 *
 * Better than Levenshtein for error titles due to:
 * - O(n+m) complexity vs O(n*m)
 * - Better prefix matching (error titles share common prefixes like "TypeError:", "MongoError:", etc.)
 *
 * @param s1 - First string
 * @param s2 - Second string
 * @param prefixScale - Scaling factor for common prefix bonus (default 0.1, max 0.25)
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
 * Calculate title similarity score using Jaro-Winkler on normalized titles
 */
export function calculateTitleSimilarity(title1: string, title2: string): number {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);

  if (norm1 === norm2) return 1;
  if (!norm1 || !norm2) return 0;

  return jaroWinklerSimilarity(norm1, norm2);
}

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
 * Find the best matching issue by title similarity
 *
 * @param proposedTitle - The title proposed by LLM for a new issue
 * @param existingIssues - List of existing issues to check against
 * @param options - Matching options (threshold, minLength)
 * @returns The best matching issue if above threshold, null otherwise
 */
export function findBestTitleMatch(
  proposedTitle: string,
  existingIssues: TitleMatchIssue[],
  options: TitleMatchOptions = {}
): { issue: TitleMatchIssue; similarity: number } | null {
  const { threshold = 0.9, minLength = 40 } = options;

  const normalizedProposed = normalizeTitle(proposedTitle);

  // Skip if title is too short (high false positive risk)
  if (normalizedProposed.length < minLength) {
    return null;
  }

  let bestMatch: { issue: TitleMatchIssue; similarity: number } | null = null;

  for (const issue of existingIssues) {
    const similarity = calculateTitleSimilarity(proposedTitle, issue.title);

    if (similarity >= threshold && (!bestMatch || similarity > bestMatch.similarity)) {
      bestMatch = { issue, similarity };
    }
  }

  return bestMatch;
}

// Semantic fingerprinting: more aggressive normalization for looser matching.

/**
 * Extract the core error message by stripping contextual details
 * More aggressive than normalizeErrorMessage() - used for semantic fingerprinting
 *
 * @example
 * Input: "MongoNetworkError: connection timed out to cluster0-shard-00-00.mongodb.net:27017"
 * Output: "MongoNetworkError: connection timed out to <TARGET>"
 *
 * Input: "ValidationException: The provided model identifier is invalid. model=anthropic.claude-3"
 * Output: "ValidationException: model identifier invalid model=<MODEL>"
 */
export function extractCoreErrorMessage(text: string): string {
  let core = text;

  // Remove Runtime wrapper
  core = core.replace(/^Runtime\.UnhandledPromiseRejection:\s*/i, '');

  // Extract first line (error message) if multi-line
  const firstLine = core.split('\n')[0].trim();
  core = firstLine;

  // Remove stack trace references that might be on the first line
  core = core.replace(/\s+at\s+.*$/i, '');

  // Apply standard normalizations first
  core = normalizeErrorMessage(core);

  // More aggressive normalizations for semantic fingerprint

  // Remove specific values after "to" or "from" (connection targets)
  core = core.replace(/\s+(to|from)\s+[^\s,]+/gi, ' $1 <TARGET>');

  // Remove specific model names
  core = core.replace(/model[=:\s]+[^\s,]+/gi, 'model=<MODEL>');

  // Remove specific service names in "service X" patterns
  core = core.replace(/service[=:\s]+[^\s,]+/gi, 'service=<SERVICE>');

  // Remove "for X" clauses
  core = core.replace(/\s+for\s+[^\s,]+/gi, ' for <TARGET>');

  // Remove specific collection/table names
  core = core.replace(/collection[=:\s]+[^\s,]+/gi, 'collection=<COLLECTION>');
  core = core.replace(/table[=:\s]+[^\s,]+/gi, 'table=<TABLE>');

  // Normalize key paths like "property 'foo'" or "key 'bar'"
  core = core.replace(/(property|key|field)\s+['"][^'"]+['"]/gi, '$1 <KEY>');

  // Remove "of undefined/null" specifics
  core = core.replace(/of\s+(undefined|null)/gi, 'of <NULLISH>');

  // Collapse multiple spaces
  core = core.replace(/\s+/g, ' ').trim();

  return core;
}

/**
 * Generate a semantic fingerprint focusing on error type + core message
 * More tolerant of variable context than the full fingerprint
 *
 * Used as a fallback when full fingerprint doesn't match but errors are semantically similar
 *
 * @returns SHA-1 hash (40 chars) or null if fingerprinting fails
 */
export function generateSemanticFingerprint(alert: SlackAlert): string | null {
  const errorType = extractErrorType(alert.text);
  const coreMessage = extractCoreErrorMessage(alert.text);

  // Require meaningful content
  if (coreMessage.length < 15) {
    return null;
  }

  const fingerprintSource = `semantic::${errorType}::${coreMessage}`;
  return sha1Hash(fingerprintSource);
}

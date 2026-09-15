/**
 * Telemetry Fingerprinting Utility
 *
 * Provides deterministic fingerprinting for context telemetry alerts.
 * Used for GitHub issue deduplication and regression detection.
 *
 * Key design decisions (following liveops/Sentry/Rollbar best practices):
 * - SHA-1 hash (40 chars) - industry standard for fingerprinting
 * - Include severity level - prevents different severities from deduplicating
 * - Include model/provider - separates issues by AI provider
 * - Include active anomaly flags - captures the specific combination of anomalies
 */

import { createHash } from 'crypto';
import type { ContextTelemetry, AnomaliesTelemetry } from '@bike4mind/common';
import {
  formatFingerprintComment as sharedFormatFingerprintComment,
  formatSemanticFingerprintComment as sharedFormatSemanticFingerprintComment,
  extractFingerprintFromBody as sharedExtractFingerprintFromBody,
  extractSemanticFingerprintFromBody as sharedExtractSemanticFingerprintFromBody,
} from './issueFingerprint';

/** Telemetry fingerprint prefix for issue body comments */
const TELEMETRY_PREFIX = 'telemetry';

// ============================================================================
// FINGERPRINT GENERATION
// ============================================================================

/**
 * Normalize model ID for fingerprinting.
 * Removes version-specific parts to group similar models together.
 *
 * @example
 * normalizeModelId('claude-3-5-sonnet-20241022') => 'claude-3-5-sonnet'
 * normalizeModelId('gpt-4o-2024-08-06') => 'gpt-4o'
 */
export function normalizeModelId(modelId: string): string {
  return (
    modelId
      // Remove date-based versions (YYYYMMDD or YYYY-MM-DD)
      .replace(/-\d{8}$/, '')
      .replace(/-\d{4}-\d{2}-\d{2}$/, '')
      // Remove trailing version numbers
      .replace(/-v\d+$/, '')
      // Lowercase for consistency
      .toLowerCase()
  );
}

/**
 * Build a sorted string of active anomaly flags.
 * Only includes anomalies that are actually triggered.
 *
 * @example
 * buildAnomalyFlags({ highUtilization: true, slowResponse: true, ... }) => 'highUtilization|slowResponse'
 */
export function buildAnomalyFlags(anomalies: AnomaliesTelemetry): string {
  const activeFlags: string[] = [];

  // Check each boolean anomaly flag
  if (anomalies.contextOverflow) activeFlags.push('contextOverflow');
  if (anomalies.highUtilization) activeFlags.push('highUtilization');
  if (anomalies.criticalUtilization) activeFlags.push('criticalUtilization');
  if (anomalies.highTruncation) activeFlags.push('highTruncation');
  if (anomalies.criticalTruncation) activeFlags.push('criticalTruncation');
  if (anomalies.toolFailureSpike) activeFlags.push('toolFailureSpike');
  if (anomalies.toolTimeout) activeFlags.push('toolTimeout');
  if (anomalies.subagentTimeout) activeFlags.push('subagentTimeout');
  if (anomalies.slowFirstToken) activeFlags.push('slowFirstToken');
  if (anomalies.slowTotalResponse) activeFlags.push('slowTotalResponse');

  // Sort for consistent fingerprinting
  return activeFlags.sort().join('|');
}

/**
 * Generate SHA-1 hash (40 chars) of the input string.
 */
function sha1Hash(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Generate a full fingerprint for telemetry-based deduplication.
 *
 * Fingerprint components:
 * 1. System prefix ('telemetry')
 * 2. Primary anomaly type (e.g., 'slow_response', 'context_overflow')
 * 3. Severity level ('critical', 'high', 'medium', 'low') - prevents over-dedup
 * 4. Normalized model ID
 * 5. Provider
 * 6. Active anomaly flags (sorted)
 *
 * @param telemetry - The context telemetry object
 * @returns SHA-1 fingerprint (40 hex chars)
 */
export function generateTelemetryFingerprint(telemetry: ContextTelemetry): string {
  const { anomalies, model } = telemetry;

  const components = [
    'telemetry',
    anomalies.primaryAnomaly,
    anomalies.severity, // Include severity to prevent different severities from deduping
    normalizeModelId(model.modelId),
    model.provider,
    buildAnomalyFlags(anomalies),
  ];

  const fingerprintSource = components.join('::');
  return sha1Hash(fingerprintSource);
}

/**
 * Generate a semantic fingerprint for looser matching.
 *
 * Semantic fingerprint uses fewer components for more aggressive deduplication:
 * 1. System prefix ('telemetry-semantic')
 * 2. Primary anomaly type
 * 3. Provider (but not specific model)
 *
 * Use this when exact fingerprint doesn't match but alerts are semantically similar.
 *
 * @param telemetry - The context telemetry object
 * @returns SHA-1 semantic fingerprint (40 hex chars)
 */
export function generateSemanticTelemetryFingerprint(telemetry: ContextTelemetry): string {
  const { anomalies, model } = telemetry;

  const components = ['telemetry-semantic', anomalies.primaryAnomaly, model.provider];

  const fingerprintSource = components.join('::');
  return sha1Hash(fingerprintSource);
}

// ============================================================================
// FINGERPRINT FORMATTING (for issue body embedding)
// ============================================================================

/**
 * Format a telemetry fingerprint as an HTML comment for embedding in issue body.
 *
 * @param fingerprint - SHA-1 fingerprint (40 hex chars)
 * @returns HTML comment string
 */
export function formatFingerprintComment(fingerprint: string): string {
  return sharedFormatFingerprintComment(fingerprint, TELEMETRY_PREFIX);
}

/**
 * Format a telemetry semantic fingerprint as an HTML comment.
 *
 * @param fingerprint - SHA-1 semantic fingerprint (40 hex chars)
 * @returns HTML comment string
 */
export function formatSemanticFingerprintComment(fingerprint: string): string {
  return sharedFormatSemanticFingerprintComment(fingerprint, TELEMETRY_PREFIX);
}

// ============================================================================
// FINGERPRINT EXTRACTION (from issue body)
// ============================================================================

/**
 * Extract telemetry fingerprint from a GitHub issue body.
 *
 * @param body - Issue body text (may be null/undefined)
 * @returns SHA-1 fingerprint (40 chars) or null if not found
 */
export function extractFingerprintFromBody(body: string | null | undefined): string | null {
  return sharedExtractFingerprintFromBody(body, TELEMETRY_PREFIX);
}

/**
 * Extract telemetry semantic fingerprint from a GitHub issue body.
 *
 * @param body - Issue body text (may be null/undefined)
 * @returns SHA-1 semantic fingerprint (40 chars) or null if not found
 */
export function extractSemanticFingerprintFromBody(body: string | null | undefined): string | null {
  return sharedExtractSemanticFingerprintFromBody(body, TELEMETRY_PREFIX);
}

// ============================================================================
// ISSUE TITLE/BODY GENERATION
// ============================================================================

// `escapeMarkdown` moved to `@server/utils/markdownEscape` - it's a generic
// Markdown/`@`-mention escape used across multiple LLM-to-GH-issue paths, not a
// telemetry-specific concern.

/**
 * Get emoji for severity level.
 */
export function getSeverityEmoji(severity: string): string {
  switch (severity) {
    case 'critical':
      return '\u{1F534}'; // Red circle
    case 'high':
      return '\u{1F7E0}'; // Orange circle
    case 'medium':
      return '\u{1F7E1}'; // Yellow circle
    default:
      return '\u{1F7E2}'; // Green circle
  }
}

/**
 * Format primary anomaly for display (replace underscores with spaces).
 */
export function formatPrimaryAnomaly(anomaly: string): string {
  return anomaly.replace(/_/g, ' ');
}

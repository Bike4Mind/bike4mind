/**
 * Shared Fingerprint Utilities for GitHub Issues
 *
 * Provides common functionality for embedding and extracting fingerprints
 * from GitHub issue bodies. The fingerprint format/extraction logic is shared
 * between LiveOps and Telemetry systems, while the generation logic is
 * system-specific (in liveopsFingerprint.ts and telemetryFingerprint.ts).
 */

import { escapeRegex } from '@bike4mind/utils/escapeRegex';

// Fingerprint format constants

/** SHA-1 hash length (40 hexadecimal characters) */
export const FINGERPRINT_LENGTH = 40;

/** Regex pattern to validate fingerprint format */
export const FINGERPRINT_PATTERN = /^[a-f0-9]{40}$/;

// Fingerprint embedding (for issue body)

/**
 * Format a fingerprint as an HTML comment for embedding in issue body.
 *
 * HTML comments are invisible when rendered but can be extracted programmatically.
 * This is the standard approach used by Sentry, Rollbar, and similar tools.
 *
 * @param fingerprint - SHA-1 fingerprint (40 hex chars)
 * @param prefix - System prefix (e.g., 'liveops', 'telemetry') - defaults to no prefix for backward compatibility
 * @returns HTML comment string to embed in issue body
 *
 * @example
 * formatFingerprintComment('abc123...', 'telemetry')
 * // Returns: <!-- telemetry-fingerprint:abc123... -->
 *
 * formatFingerprintComment('abc123...')
 * // Returns: <!-- fingerprint:abc123... --> (backward compatible with liveops)
 */
export function formatFingerprintComment(fingerprint: string, prefix?: string): string {
  if (prefix) {
    return `<!-- ${prefix}-fingerprint:${fingerprint} -->`;
  }
  // Backward compatible format (used by liveops)
  return `<!-- fingerprint:${fingerprint} -->`;
}

/**
 * Format a semantic fingerprint as an HTML comment for embedding in issue body.
 * Semantic fingerprints use more aggressive normalization for looser matching.
 *
 * @param fingerprint - SHA-1 semantic fingerprint (40 hex chars)
 * @param prefix - System prefix (e.g., 'liveops', 'telemetry') - defaults to no prefix for backward compatibility
 * @returns HTML comment string to embed in issue body
 */
export function formatSemanticFingerprintComment(fingerprint: string, prefix?: string): string {
  if (prefix) {
    return `<!-- ${prefix}-semantic-fingerprint:${fingerprint} -->`;
  }
  // Backward compatible format (used by liveops)
  return `<!-- semantic-fingerprint:${fingerprint} -->`;
}

// Fingerprint extraction (from issue body)

/**
 * Extract a fingerprint from an issue body by prefix.
 *
 * When a prefix is specified, only matches prefixed format (strict mode).
 * When no prefix is specified, matches non-prefixed format (backward compatible with liveops).
 *
 * @param body - Issue body text (may be null/undefined)
 * @param prefix - Optional system prefix to look for. If provided, only matches prefixed format.
 * @returns SHA-1 fingerprint (40 chars) or null if not found
 *
 * @example
 * extractFingerprintFromBody('...<!-- telemetry-fingerprint:abc123... -->...', 'telemetry')
 * // Returns: 'abc123...'
 *
 * extractFingerprintFromBody('...<!-- fingerprint:abc123... -->...')
 * // Returns: 'abc123...' (backward compatible with liveops)
 *
 * extractFingerprintFromBody('...<!-- fingerprint:abc123... -->...', 'telemetry')
 * // Returns: null (strict mode - only matches telemetry-fingerprint:xxx)
 */
export function extractFingerprintFromBody(body: string | null | undefined, prefix?: string): string | null {
  if (!body) return null;

  // If prefix is provided, use strict mode - only match prefixed format
  if (prefix) {
    const escapedPrefix = escapeRegex(prefix);
    const prefixedPattern = new RegExp(`<!-- ${escapedPrefix}-fingerprint:([a-f0-9]{40}) -->`, 'i');
    const prefixedMatch = body.match(prefixedPattern);
    return prefixedMatch?.[1] || null;
  }

  // No prefix - use non-prefixed format (backward compatible with liveops)
  const genericPattern = /<!-- fingerprint:([a-f0-9]{40}) -->/i;
  const genericMatch = body.match(genericPattern);
  return genericMatch?.[1] || null;
}

/**
 * Extract a semantic fingerprint from an issue body by prefix.
 *
 * When a prefix is specified, only matches prefixed format (strict mode).
 * When no prefix is specified, matches non-prefixed format (backward compatible with liveops).
 *
 * @param body - Issue body text (may be null/undefined)
 * @param prefix - Optional system prefix to look for. If provided, only matches prefixed format.
 * @returns SHA-1 semantic fingerprint (40 chars) or null if not found
 */
export function extractSemanticFingerprintFromBody(body: string | null | undefined, prefix?: string): string | null {
  if (!body) return null;

  // If prefix is provided, use strict mode - only match prefixed format
  if (prefix) {
    const escapedPrefix = escapeRegex(prefix);
    const prefixedPattern = new RegExp(`<!-- ${escapedPrefix}-semantic-fingerprint:([a-f0-9]{40}) -->`, 'i');
    const prefixedMatch = body.match(prefixedPattern);
    return prefixedMatch?.[1] || null;
  }

  // No prefix - use non-prefixed format (backward compatible with liveops)
  const genericPattern = /<!-- semantic-fingerprint:([a-f0-9]{40}) -->/i;
  const genericMatch = body.match(genericPattern);
  return genericMatch?.[1] || null;
}

// Validation helpers

/**
 * Validate that a string is a valid SHA-1 fingerprint (40 hex chars).
 *
 * @param value - String to validate
 * @returns true if valid fingerprint format
 */
export function isValidFingerprint(value: string | null | undefined): value is string {
  if (!value) return false;
  return FINGERPRINT_PATTERN.test(value);
}

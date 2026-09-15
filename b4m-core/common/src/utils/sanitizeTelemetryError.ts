/**
 * Telemetry Error Sanitizer
 *
 * Removes PII (Personally Identifiable Information) from error messages
 * before storing them in telemetry. This ensures GDPR/CCPA compliance.
 *
 * Sanitization includes:
 * - File paths (e.g., /Users/erik/... -> [PATH])
 * - Email addresses (e.g., user@domain.com -> [EMAIL])
 * - API keys and tokens (long alphanumeric strings -> [REDACTED])
 * - IP addresses
 * - URLs with potential user info
 */

/** Maximum length for sanitized error messages */
const MAX_ERROR_LENGTH = 200;

/** Patterns for PII detection */
const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string | ((match: string) => string) }> = [
  // File paths (Unix and Windows)
  {
    pattern: /(?:\/(?:Users|home|var|tmp|etc|opt)\/[^\s]+)|(?:[A-Z]:\\[^\s]+)/gi,
    replacement: '[PATH]',
  },

  // Email addresses
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '[EMAIL]',
  },

  // API keys / tokens (long alphanumeric strings, 20+ chars)
  // Matches patterns like: sk-xxx, api_key_xxx, Bearer xxx
  {
    pattern: /(?:sk-|api[_-]?key[_-]?|bearer\s+|token[_-]?)[a-zA-Z0-9_-]{20,}/gi,
    replacement: '[REDACTED]',
  },

  // Generic long alphanumeric strings that look like secrets (32+ chars)
  {
    pattern: /\b[a-zA-Z0-9]{32,}\b/g,
    replacement: '[REDACTED]',
  },

  // IPv4 addresses
  {
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: '[IP]',
  },

  // IPv6 addresses (simplified pattern)
  {
    pattern: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    replacement: '[IP]',
  },

  // URLs with potential user info (query params, paths)
  {
    pattern: /https?:\/\/[^\s]+/g,
    replacement: (match: string) => {
      try {
        const url = new URL(match);
        // Keep just the hostname, remove path and query params
        return `[URL:${url.hostname}]`;
      } catch {
        return '[URL]';
      }
    },
  },

  // MongoDB ObjectIds in error messages
  {
    pattern: /\b[a-f0-9]{24}\b/gi,
    replacement: '[ID]',
  },

  // JWT tokens
  {
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    replacement: '[JWT]',
  },

  // AWS ARNs
  {
    pattern: /arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d*:[^\s]+/gi,
    replacement: '[ARN]',
  },

  // Phone numbers (various formats)
  {
    pattern: /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
    replacement: '[PHONE]',
  },
];

/**
 * Sanitizes an error message by removing PII
 *
 * @param error - The error message or Error object to sanitize
 * @param maxLength - Maximum length for the output (default: 200)
 * @returns Sanitized error string, truncated if necessary
 */
export function sanitizeTelemetryError(error: unknown, maxLength: number = MAX_ERROR_LENGTH): string {
  let errorString: string;

  if (error instanceof Error) {
    errorString = error.message;
  } else if (typeof error === 'string') {
    errorString = error;
  } else if (error && typeof error === 'object') {
    try {
      errorString = JSON.stringify(error);
    } catch {
      errorString = String(error);
    }
  } else {
    errorString = String(error ?? 'Unknown error');
  }

  let sanitized = errorString;

  for (const { pattern, replacement } of PII_PATTERNS) {
    // Reset lastIndex for global patterns to ensure all matches are found
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, replacement as string);
  }

  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength - 3) + '...';
  }

  return sanitized;
}

/**
 * Sanitizes an array of error messages
 *
 * @param errors - Array of error messages or Error objects
 * @param maxLength - Maximum length for each error (default: 200)
 * @returns Array of sanitized error strings
 */
export function sanitizeTelemetryErrors(errors: unknown[], maxLength: number = MAX_ERROR_LENGTH): string[] {
  return errors.map(error => sanitizeTelemetryError(error, maxLength));
}

/**
 * Checks if a string likely contains PII
 *
 * Useful for logging decisions before capture
 *
 * @param text - The text to check
 * @returns true if PII patterns are detected
 */
export function containsPII(text: string): boolean {
  for (const { pattern } of PII_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

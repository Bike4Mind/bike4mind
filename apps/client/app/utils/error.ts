import { AxiosError, isAxiosError } from 'axios';

export interface ErrorResponse {
  message?: string;
  error?: string;
}

export function getErrorMessage(error: unknown): string {
  if (isAxiosError(error)) return handleAxiosError(error);

  // Handle other types of errors (e.g., native JS errors)
  if (error instanceof Error) {
    return error.message || 'An unexpected error occurred.';
  }

  // Default fallback message for unknown error types
  return 'An unexpected error occurred.';
}

function handleAxiosError(error: AxiosError<ErrorResponse>) {
  if (error.response) {
    const data = error.response.data;
    if (typeof data === 'string') {
      return data;
    }
    return data.message || data.error || `Error: ${error.response.status}`;
  } else if (error.request) {
    return 'No response received from the server.';
  } else {
    return error.message || 'An error occurred while making the request.';
  }
}

/**
 * Get a generic error message for production environments.
 */
export function getProductionErrorMessage(error: unknown): string {
  if (process.env.NODE_ENV === 'production') {
    return 'An error occurred. Please try again later or contact support.';
  }
  return getErrorMessage(error);
}

/**
 * Sanitize error message to avoid exposing sensitive details like app IDs, tokens, etc.
 * P1: Security requirement - never expose API error details to UI
 * Reference: OWASP A10:2025 - Mishandling of Exceptional Conditions
 */
export function sanitizeErrorMessage(message: string): string {
  // Order matters: more specific patterns first, then general patterns
  const sensitivePatterns = [
    // GitHub tokens (all 6 official types)
    /ghp_[a-zA-Z0-9]{36,}/g, // GitHub PATs (classic)
    /gho_[a-zA-Z0-9]{36}/g, // GitHub OAuth tokens
    /ghu_[a-zA-Z0-9]{36}/g, // GitHub user-to-server tokens
    // Matches both the classic 40-char opaque token and the new stateless JWT
    // format (~520 chars, base64url segments joined by dots). GitHub is rolling
    // installation tokens over to the JWT format, so the charset must allow `._-`
    // and the length must be open-ended. See:
    // https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/
    /ghs_[a-zA-Z0-9._-]{36,}/g, // GitHub server-to-server (installation) tokens
    /ghr_[a-zA-Z0-9]{36}/g, // GitHub refresh tokens
    /github_pat_[a-zA-Z0-9_]{22,}/g, // GitHub fine-grained PATs

    // PEM keys (SSH, RSA, etc.)
    /-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g,

    // Key=value patterns with sensitive names
    /\b(appId|installationId|privateKey|accessToken|client_secret|api_key)[=:]\s*["']?[^"'\s,}]+["']?/gi,

    // AWS credentials
    /AKIA[0-9A-Z]{16}/g, // AWS Access Key ID
    /ASIA[0-9A-Z]{16}/g, // AWS Temporary Access Key

    // Generic long hex strings (40+ chars - potential tokens/hashes)
    // May catch git SHAs but that's acceptable for security
    /\b[a-f0-9]{40,}\b/gi,
  ];

  let sanitized = message;
  for (const pattern of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

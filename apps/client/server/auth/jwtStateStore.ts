import jwt, { Algorithm, SignOptions, VerifyOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { Config } from '@server/utils/config';
import { Logger } from '@bike4mind/observability';

// Default expiration for OAuth state (5 minutes is industry standard)
const DEFAULT_EXPIRES_IN = '5m' as const;

// JWT algorithm - explicitly pinned for security (prevents algorithm confusion attacks)
const JWT_ALGORITHM: Algorithm = 'HS256';

// Common issuer for all OAuth state tokens
const JWT_ISSUER = 'bike4mind' as const;

/**
 * Options for creating a JWT state store
 */
export interface JwtStateStoreOptions {
  /** Unique audience identifier for this OAuth provider (e.g., 'okta-oauth-state', 'slack-oauth-state') */
  audience: string;
  /** Token expiration time (default: '5m') */
  expiresIn?: SignOptions['expiresIn'];
}

/**
 * Base payload structure for OAuth state tokens
 */
export interface BaseStatePayload {
  handle: string;
  createdAt: number;
  aud: string;
  iss: string;
}

/**
 * Result of verifying a state token
 */
export type VerifyResult<T = unknown> =
  | { valid: true; payload: T }
  | { valid: false; reason: 'missing' | 'expired' | 'invalid'; message: string };

/**
 * Validates that JWT_SECRET is configured
 * @throws Error if JWT_SECRET is not configured
 */
export function validateJwtSecret(): string {
  const secret = Config.JWT_SECRET;
  if (!secret) {
    throw new Error('Missing JWT_SECRET configuration for OAuth state signing');
  }
  return secret;
}

/**
 * Creates a signed JWT state token for OAuth CSRF protection.
 *
 * Security features:
 * - HS256 algorithm pinning (prevents algorithm confusion attacks)
 * - OIDC standard claims (aud, iss) for defense-in-depth
 * - Cryptographically secure random handle
 * - Configurable expiration (default 5 minutes)
 *
 * @param options - Configuration options
 * @param additionalPayload - Optional additional data to include in the token
 * @returns Signed JWT token string
 */
export function createStateToken<T extends Record<string, unknown>>(
  options: JwtStateStoreOptions,
  additionalPayload?: T
): string {
  const secret = validateJwtSecret();

  const payload: BaseStatePayload & T = {
    handle: randomUUID(),
    createdAt: Date.now(),
    aud: options.audience,
    iss: JWT_ISSUER,
    ...additionalPayload,
  } as BaseStatePayload & T;

  const signOptions: SignOptions = {
    expiresIn: options.expiresIn ?? DEFAULT_EXPIRES_IN,
    algorithm: JWT_ALGORITHM,
  };

  return jwt.sign(payload, secret, signOptions);
}

/**
 * Verifies a JWT state token and returns the decoded payload.
 *
 * Security features:
 * - Explicit algorithm restriction (prevents alg:none attacks)
 * - Audience and issuer validation
 * - Expiration checking
 *
 * @param token - The JWT token to verify
 * @param options - Configuration options (must match options used to create token)
 * @returns Verification result with payload or error reason
 */
export function verifyStateToken<T extends BaseStatePayload>(
  token: string,
  options: JwtStateStoreOptions
): VerifyResult<T> {
  if (!token) {
    return { valid: false, reason: 'missing', message: 'Missing state parameter' };
  }

  const secret = validateJwtSecret();

  const verifyOptions: VerifyOptions = {
    algorithms: [JWT_ALGORITHM],
    audience: options.audience,
    issuer: JWT_ISSUER,
  };

  try {
    const decoded = jwt.verify(token, secret, verifyOptions) as T;
    return { valid: true, payload: decoded };
  } catch (err: unknown) {
    const error = err as { name?: string; message?: string };
    if (error.name === 'TokenExpiredError') {
      return {
        valid: false,
        reason: 'expired',
        message: 'Authorization request expired. Please try again.',
      };
    }
    Logger.warn('JWT state verification failed', { error: error.message });
    return { valid: false, reason: 'invalid', message: 'Invalid authorization state.' };
  }
}

/**
 * Type guard to check if an error is a JWT-related error
 */
export function isJwtError(error: unknown): error is { name: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    'message' in error &&
    typeof (error as { name: unknown }).name === 'string' &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * Shared constants and types for Okta OAuth authentication.
 */
import { BaseStatePayload } from '@server/auth/jwtStateStore';

/**
 * Audience claim for Okta OAuth state JWT tokens.
 * Used to bind state tokens to the Okta OAuth flow and prevent token reuse.
 */
export const OKTA_STATE_AUDIENCE = 'okta-oauth-state';

/**
 * Standard URL truncation length for logging.
 * Used consistently across OAuth/SAML flows to avoid exposing full URLs in logs.
 */
export const LOG_URL_TRUNCATE_LENGTH = 80;

/**
 * Additional state data for Okta OAuth flow (used when creating state token).
 * Contains IDP routing info and PKCE verifier for secure token exchange.
 */
export interface OktaStateInput {
  /** Identity Provider ID for callback routing */
  idpId?: string;
  /** PKCE code verifier for token exchange */
  codeVerifier: string;
  /** Post-login path to resume, round-tripped via the state JWT */
  redirectTo?: string;
  [key: string]: unknown; // Required for Record<string, unknown> compatibility
}

/**
 * Full state payload for Okta OAuth flow (used when verifying state token).
 * Includes both the base JWT claims and the Okta-specific fields.
 */
export interface OktaStatePayload extends BaseStatePayload {
  /** Identity Provider ID for callback routing */
  idpId?: string;
  /** PKCE code verifier for token exchange */
  codeVerifier: string;
  /** Post-login path to resume, round-tripped via the state JWT */
  redirectTo?: string;
}

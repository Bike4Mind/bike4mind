import type { ApiConfig } from '../storage/types';

/**
 * Default service endpoint, baked in at build time via tsdown's `env` option
 * (see `packages/cli/tsdown.config.ts`). The hosted publisher builds with its own
 * service as the default; a fork sets `B4M_DEFAULT_API_URL` to publish under a
 * different brand, so a fork's bundle never embeds the upstream brand literal.
 * Empty when unset - the user then supplies an endpoint via `/set-api` or the
 * `--dev` flag.
 */
export function getDefaultApiUrl(): string {
  return process.env.B4M_DEFAULT_API_URL ?? '';
}

/** Local development server the `--dev` flag points the CLI at. */
export const LOCAL_DEV_URL = 'http://localhost:3001';

/**
 * Marketing/credits page shown when the user runs out of credits. Build-time
 * injected like {@link getDefaultApiUrl}; empty for an unbranded fork, in which
 * case the "purchase more credits" line is omitted entirely.
 */
export function getCreditsUrl(): string {
  return process.env.B4M_CREDITS_URL ?? '';
}

/**
 * Resolve API URL based on configuration
 * Returns custom URL if set, otherwise the build-time default service.
 */
export function getApiUrl(configApiConfig?: ApiConfig): string {
  // Return custom URL if configured (self-hosted)
  if (configApiConfig?.customUrl) {
    return configApiConfig.customUrl;
  }

  // Default to the build-time-configured service (empty for an unbranded fork)
  return getDefaultApiUrl();
}

/**
 * Get human-readable API type name
 */
export function getEnvironmentName(configApiConfig?: ApiConfig): string {
  const url = configApiConfig?.customUrl;

  if (!url) {
    // No custom URL -> the build-time default service. An unbranded fork that baked
    // no default (empty) has no configured service to name, so report "Unconfigured"
    // rather than a misleading "Production".
    return getDefaultApiUrl() ? 'Production' : 'Unconfigured';
  }

  // Local dev servers (localhost / 127.0.0.1) read as "Local Dev"
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) {
    return 'Local Dev';
  }

  return 'Self-Hosted';
}

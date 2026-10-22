import { selectApiEndpoint, type ApiEndpoint } from '@bike4mind/client-auth';
import type { ApiConfig } from '../storage/types';

export { LOCAL_DEV_URL, parseApiUrl, type ApiEndpoint } from '@bike4mind/client-auth';

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

/**
 * True when the CLI is running from TypeScript source rather than a built
 * `dist/` bundle (a `pnpm link --global` checkout, `pnpm dev`, etc). The bin
 * sets `B4M_SOURCE_MODE=1` in this case (see `bin/bike4mind-cli.mjs`).
 *
 * It matters here because build-time brand defaults (`B4M_DEFAULT_API_URL`) are
 * only injected into a real build - a source run always sees them empty. Rather
 * than leave a contributor unconfigured, we default source runs to the local dev
 * server, which is almost always what they want.
 */
export function isSourceMode(): boolean {
  return process.env.B4M_SOURCE_MODE === '1';
}

/**
 * Marketing/credits page shown when the user runs out of credits. Build-time
 * injected like {@link getDefaultApiUrl}; empty for an unbranded fork, in which
 * case the "purchase more credits" line is omitted entirely.
 */
export function getCreditsUrl(): string {
  return process.env.B4M_CREDITS_URL ?? '';
}

/**
 * Resolve which backend the CLI should talk to, feeding the CLI's build-time brand
 * defaults into the shared precedence rule (custom URL, then baked default, then the
 * local dev server for a source run, then unconfigured).
 *
 * Never returns an empty URL - callers get `unconfigured` instead.
 */
export function resolveApiEndpoint(configApiConfig?: ApiConfig): ApiEndpoint {
  return selectApiEndpoint({
    customUrl: configApiConfig?.customUrl,
    bakedDefault: getDefaultApiUrl(),
    devFallback: isSourceMode(),
  });
}

/**
 * Thrown when a network operation needs an endpoint but none is configured.
 * The message is user-facing and actionable - it tells the developer exactly
 * how to point the CLI at a backend.
 */
export class ApiEndpointUnconfiguredError extends Error {
  constructor() {
    super(
      'No API endpoint configured. Point the CLI at a backend first:\n' +
        '  b4m --dev              # local dev server (http://localhost:3000)\n' +
        '  b4m --api-url <url>    # a hosted or self-hosted instance'
    );
    this.name = 'ApiEndpointUnconfiguredError';
  }
}

/**
 * Resolve the API URL for a network call, failing loud when unconfigured.
 * Use this at the network boundary (constructing an `ApiClient` / `OAuthClient`)
 * so a missing endpoint throws an actionable error instead of an empty
 * `baseURL` producing an opaque "Invalid URL".
 */
export function requireApiUrl(configApiConfig?: ApiConfig): string {
  const endpoint = resolveApiEndpoint(configApiConfig);
  if (endpoint.status === 'unconfigured') {
    throw new ApiEndpointUnconfiguredError();
  }
  return endpoint.url;
}

/**
 * Get human-readable API type name for display (banner, `/api-info`).
 */
export function getEnvironmentName(configApiConfig?: ApiConfig): string {
  const endpoint = resolveApiEndpoint(configApiConfig);

  // An unbranded fork / source checkout with no baked default has no configured
  // service to name - report "Unconfigured" rather than a misleading "Production".
  if (endpoint.status === 'unconfigured') {
    return 'Unconfigured';
  }

  // The build-time default service is the hosted production backend.
  if (endpoint.source === 'baked-default') {
    return 'Production';
  }

  // The source-mode fallback points at the local dev server.
  if (endpoint.source === 'dev-default') {
    return 'Local Dev';
  }

  // Custom localhost / 127.0.0.1 URLs also read as "Local Dev".
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(endpoint.url)) {
    return 'Local Dev';
  }

  return 'Self-Hosted';
}

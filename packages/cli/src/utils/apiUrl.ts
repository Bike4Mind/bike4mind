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
 * The backend the CLI talks to, modeled as a discriminated union so that
 * "no endpoint configured" is a distinct, explicit state rather than an empty
 * string masquerading as a URL. This keeps a missing endpoint from silently
 * reaching the network layer, where it surfaced as a cryptic axios
 * "Invalid URL" three layers away from the actual configuration problem.
 *
 * `source` records how the URL was resolved:
 * - `custom`        - the user set it via `--api-url` / `/set-api`
 * - `baked-default` - the build-time default baked into the published binary
 */
export type ApiEndpoint =
  | { status: 'configured'; url: string; source: 'custom' | 'baked-default' }
  | { status: 'unconfigured' };

/**
 * Resolve which backend the CLI should talk to. A configured custom URL wins;
 * otherwise the build-time default service is used; otherwise the endpoint is
 * unconfigured (an unbranded fork or a source/linked checkout that never baked
 * a default). Never returns an empty URL - callers get `unconfigured` instead.
 */
export function resolveApiEndpoint(configApiConfig?: ApiConfig): ApiEndpoint {
  if (configApiConfig?.customUrl) {
    return { status: 'configured', url: configApiConfig.customUrl, source: 'custom' };
  }

  const bakedDefault = getDefaultApiUrl();
  if (bakedDefault) {
    return { status: 'configured', url: bakedDefault, source: 'baked-default' };
  }

  return { status: 'unconfigured' };
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
        '  b4m --dev              # local dev server (http://localhost:3001)\n' +
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

  // Local dev servers (localhost / 127.0.0.1) read as "Local Dev".
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(endpoint.url)) {
    return 'Local Dev';
  }

  return 'Self-Hosted';
}

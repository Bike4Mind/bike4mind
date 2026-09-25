import { LOCAL_DEV_URL, parseApiUrl, selectApiEndpoint, type ApiEndpoint } from '@bike4mind/client-auth';
import type { EnvironmentSelection, ResolvedEnvironment } from '@shared/auth';

/**
 * Default service endpoint, baked in at build time (see the `define` block in
 * electron.vite.config.ts), exactly as the CLI bakes `B4M_DEFAULT_API_URL` via tsdown. Empty
 * for an unbranded fork, which then has no `hosted` option and must pick local or custom.
 */
export function bakedDefaultApiUrl(): string {
  return process.env.B4M_DEFAULT_API_URL ?? '';
}

export function hostedAvailable(): boolean {
  return bakedDefaultApiUrl() !== '';
}

/** Mirrors the CLI's `getEnvironmentName`, so the two clients label a backend the same way. */
function labelFor(endpoint: Extract<ApiEndpoint, { status: 'configured' }>): string {
  if (endpoint.source === 'baked-default') return 'Production';
  if (endpoint.source === 'dev-default') return 'Local Dev';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(endpoint.url)) return 'Local Dev';
  return 'Self-Hosted';
}

/**
 * Turn a user's picker choice into a concrete endpoint, or report that none resolves.
 *
 * `devFallback` is `!app.isPackaged`: a developer running from source gets the local server
 * rather than an unconfigured app, while a packaged unbranded build is honestly unconfigured
 * instead of silently pointing at a localhost that is not there.
 */
export function resolveEnvironment(
  selection: EnvironmentSelection | undefined,
  devFallback: boolean
): { status: 'configured'; environment: ResolvedEnvironment } | { status: 'unconfigured' } {
  const preset = selection?.preset;

  // `local` is an explicit pick, so it bypasses the precedence rule entirely - the baked
  // default must not win over a user who deliberately chose the dev server.
  if (preset === 'local') {
    return { status: 'configured', environment: { preset: 'local', url: LOCAL_DEV_URL, label: 'Local Dev' } };
  }

  const customUrl = preset === 'custom' ? selection?.customUrl : undefined;
  const endpoint = selectApiEndpoint({
    customUrl,
    // A `custom` pick that lost its URL must not silently fall back to the hosted service
    // under a "Custom" label; leave it unconfigured so the user re-enters one.
    bakedDefault: preset === 'custom' ? '' : bakedDefaultApiUrl(),
    devFallback: preset === 'custom' ? false : devFallback,
  });

  if (endpoint.status === 'unconfigured') return { status: 'unconfigured' };

  const resolvedPreset =
    endpoint.source === 'custom' ? 'custom' : endpoint.source === 'baked-default' ? 'hosted' : 'local';

  return {
    status: 'configured',
    environment: { preset: resolvedPreset, url: endpoint.url, label: labelFor(endpoint) },
  };
}

/** Validate a picker submission before it is persisted. */
export function validateSelection(selection: EnvironmentSelection): { ok: true } | { ok: false; error: string } {
  if (selection.preset !== 'custom') return { ok: true };

  const parsed = parseApiUrl(selection.customUrl ?? '');
  return 'error' in parsed ? { ok: false, error: parsed.error } : { ok: true };
}

/** Normalize a picker submission so the stored custom URL is the same string used as a cache key. */
export function normalizeSelection(selection: EnvironmentSelection): EnvironmentSelection {
  if (selection.preset !== 'custom') return { preset: selection.preset };

  const parsed = parseApiUrl(selection.customUrl ?? '');
  return { preset: 'custom', customUrl: 'url' in parsed ? parsed.url : selection.customUrl };
}

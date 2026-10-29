import {
  LOCAL_DEV_URL,
  normalizeEnvKey,
  parseApiUrl,
  selectApiEndpoint,
  type ApiEndpoint,
} from '@bike4mind/client-auth';
import type { EnvironmentSelection, ResolvedEnvironment } from '@shared/auth';

/**
 * Default service endpoint, baked in at build time (see the `define` block in
 * electron.vite.config.ts). Builds default to Production; publishers can override the URL.
 */
export function bakedDefaultApiUrl(): string {
  return process.env.B4M_DEFAULT_API_URL ?? '';
}

export function hostedAvailable(): boolean {
  return bakedDefaultApiUrl() !== '';
}

/** Require both the same endpoint and token key before reusing a stored session. */
function isBakedDefault(url: string): boolean {
  const bakedUrl = bakedDefaultApiUrl();
  const baked = parseApiUrl(bakedUrl);
  if ('error' in baked) return false;
  // Cache keys lowercase paths too; endpoint matching must preserve their case.
  return new URL(url).href === new URL(bakedUrl).href && normalizeEnvKey(url) === normalizeEnvKey(bakedUrl);
}

/**
 * A `custom` pick of the baked production URL, which a build released without its baked default
 * forced users to type in, is really `hosted`: it should say "Production" and follow the default
 * if that ever moves. Anything else is returned as is.
 */
export function migrateSelection<T extends EnvironmentSelection | undefined>(selection: T): T | EnvironmentSelection {
  if (selection?.preset !== 'custom' || !selection.customUrl) return selection;
  const parsed = parseApiUrl(selection.customUrl);
  return 'url' in parsed && isBakedDefault(parsed.url) ? { preset: 'hosted' } : selection;
}

/**
 * Mirrors the CLI's `getEnvironmentName` resolution order. The names match except for a custom
 * URL, which the desktop calls "Remote" where the CLI still says "Self-Hosted".
 */
function labelFor(endpoint: Extract<ApiEndpoint, { status: 'configured' }>): string {
  if (endpoint.source === 'baked-default') return 'Production';
  if (endpoint.source === 'dev-default') return 'Local Dev';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(endpoint.url)) return 'Local Dev';
  return 'Remote';
}

/**
 * Turn a user's picker choice into a concrete endpoint, or report that none resolves.
 *
 * `devFallback` is `!app.isPackaged`: when no baked default is available, a source run uses
 * the local server while a packaged build stays unconfigured. Normal builds bake Production.
 */
export function resolveEnvironment(
  selection: EnvironmentSelection | undefined,
  devFallback: boolean
): { status: 'configured'; environment: ResolvedEnvironment } | { status: 'unconfigured' } {
  const migrated = migrateSelection(selection);
  const preset = migrated?.preset;

  // `local` is an explicit pick, so it bypasses the precedence rule entirely - the baked
  // default must not win over a user who deliberately chose the dev server.
  if (preset === 'local') {
    return { status: 'configured', environment: { preset: 'local', url: LOCAL_DEV_URL, label: 'Local Dev' } };
  }

  const customUrl = preset === 'custom' ? migrated?.customUrl : undefined;
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
  return migrateSelection({ preset: 'custom', customUrl: 'url' in parsed ? parsed.url : selection.customUrl });
}

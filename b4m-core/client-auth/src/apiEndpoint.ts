/** Local development server a client's `--dev` / dev build points at. */
export const LOCAL_DEV_URL = 'http://localhost:3000';

/**
 * Normalize and validate a user-supplied API URL. The single source of truth for what counts
 * as an acceptable endpoint across every client. Trims surrounding whitespace, strips trailing
 * slashes, and requires an http(s) origin.
 *
 * Returns a discriminated result rather than throwing so each caller can render the failure in
 * its own idiom (a CLI `process.exit`, an Ink error line, a form field, ...).
 */
export function parseApiUrl(raw: string): { url: string } | { error: string } {
  const url = raw.trim().replace(/\/+$/, '');
  if (!url) {
    return { error: 'Please enter a URL.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `Invalid URL: ${url}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Only http:// and https:// URLs are supported (got ${parsed.protocol}//)` };
  }

  return { url };
}

/**
 * The backend a client talks to, modeled as a discriminated union so that "no endpoint
 * configured" is a distinct, explicit state rather than an empty string masquerading as a URL.
 * This keeps a missing endpoint from silently reaching the network layer, where it surfaced as
 * a cryptic axios "Invalid URL" three layers away from the actual configuration problem.
 *
 * `source` records how the URL was resolved:
 * - `custom`        - the user set it explicitly
 * - `baked-default` - the build-time default baked into the published binary
 * - `dev-default`   - the local dev server, auto-selected for a build that has no custom or
 *                     baked URL
 */
export type ApiEndpoint =
  | { status: 'configured'; url: string; source: 'custom' | 'baked-default' | 'dev-default' }
  | { status: 'unconfigured' };

export interface ApiEndpointInputs {
  /** An endpoint the user chose explicitly. */
  customUrl?: string;
  /** The brand default a publisher baked in at build time; empty for an unbranded fork. */
  bakedDefault?: string;
  /** Fall back to {@link LOCAL_DEV_URL} when neither of the above is set (a source/dev run). */
  devFallback?: boolean;
}

/**
 * Resolve which backend to talk to, in precedence order: an explicit user choice, the
 * build-time default, then the local dev server for a dev run. Never returns an empty URL -
 * callers get `unconfigured` instead.
 *
 * Where each input comes from is the host's business: this package reads no environment.
 */
export function selectApiEndpoint(inputs: ApiEndpointInputs): ApiEndpoint {
  if (inputs.customUrl) {
    return { status: 'configured', url: inputs.customUrl, source: 'custom' };
  }

  if (inputs.bakedDefault) {
    return { status: 'configured', url: inputs.bakedDefault, source: 'baked-default' };
  }

  if (inputs.devFallback) {
    return { status: 'configured', url: LOCAL_DEV_URL, source: 'dev-default' };
  }

  return { status: 'unconfigured' };
}

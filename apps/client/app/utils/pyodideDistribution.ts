/**
 * Where the Pyodide distribution is served from, and the one place that decides it.
 *
 * Two consumers with very different jobs must agree on this exact origin, which is why it is
 * not inlined at either:
 *  - `proxy.ts` allow-lists it in the APP origin's `script-src`/`connect-src`;
 *  - `/api/pyodide-sandbox` allow-lists it in the SANDBOX origin's CSP, where it is the only
 *    host `connect-src` permits at all. Python artifacts execute there, so a mismatch is not a
 *    broken feature but a hole - too wide and the sandbox regains network reach, too narrow and
 *    Pyodide cannot load its own wasm.
 *
 * `sandboxWorkerBody.ts` carries its own copy of the default because it is serialized away from
 * module scope and can close over nothing; `sandboxWorkerBody.test.ts` pins the two in lockstep.
 */

/** Pinned distribution. Changing the version means changing it in sandboxWorkerBody.ts too. */
export const DEFAULT_PYODIDE_BASE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/';

/**
 * Resolve the operator's `PYODIDE_BASE_URL` (a self-hosted mirror for offline/air-gapped
 * deployments) to a bare origin suitable for a CSP source list.
 *
 * Returns '' when unset or invalid, and warns - a misconfigured mirror must not be able to
 * inject a second source into a CSP directive, so anything carrying whitespace or ';' is
 * refused outright. http is permitted because a LAN mirror may have no TLS.
 */
export function resolvePyodideMirrorOrigin(raw: string | undefined): string {
  if (!raw) return '';

  try {
    if (/[\s;]/.test(raw)) throw new Error('contains whitespace or ";"');
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`must be http(s) (got ${url.protocol})`);
    }
    return url.origin;
  } catch (error) {
    console.warn(
      `[csp] ignoring invalid PYODIDE_BASE_URL "${raw}": ${error instanceof Error ? error.message : String(error)}`
    );
    return '';
  }
}

/** The origin of the pinned default distribution, e.g. `https://cdn.jsdelivr.net`. */
export const DEFAULT_PYODIDE_ORIGIN = new URL(DEFAULT_PYODIDE_BASE_URL).origin;

/**
 * Every origin Pyodide may be fetched from, for a CSP source list. The default CDN is always
 * present so a deployment that later clears its mirror keeps working.
 */
export function pyodideCspSources(raw: string | undefined): string[] {
  const mirror = resolvePyodideMirrorOrigin(raw);
  return mirror && mirror !== DEFAULT_PYODIDE_ORIGIN ? [DEFAULT_PYODIDE_ORIGIN, mirror] : [DEFAULT_PYODIDE_ORIGIN];
}

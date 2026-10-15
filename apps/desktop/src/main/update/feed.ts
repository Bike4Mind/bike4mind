/**
 * Where this build looks for updates.
 *
 * The URL is baked in at build time from B4M_UPDATE_FEED_URL, exactly the way the default
 * backend is baked in from B4M_DEFAULT_API_URL - see the `define` block in
 * electron.vite.config.ts. It is NOT in this repo and must not be: this repo is public, and a
 * release feed is a hostname or a bucket behind one. A fork that sets nothing gets a build with
 * updates switched off, which is the correct behaviour for a fork that publishes no releases.
 *
 * electron-updater's `generic` provider is what consumes it, rather than the `s3` or `github`
 * providers, for the same reason: those take a bucket name or an owner/repo in configuration
 * that would have to be committed. `generic` takes a plain URL that any static host can serve,
 * so the distribution choice stays a deployment decision instead of a source-code one.
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validate and normalise the configured feed, or null for "this build does not update".
 *
 * https only, with loopback the one exception. The signature check is what actually stops a
 * hostile payload, but a plaintext feed still lets anyone on the path decide WHICH signed build
 * gets offered - including an old one with a known hole - so http is not accepted from a real
 * host. Loopback is allowed because it is the only way to exercise the check path locally, and
 * nothing on the loop is on the path.
 */
export function resolveFeedUrl(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol === 'https:') return parsed.href;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.href;
  return null;
}

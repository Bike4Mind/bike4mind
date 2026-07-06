/**
 * External API config command (--api-url / --reset-api)
 * Runs outside the interactive CLI session, before any auth flow.
 *
 * - `--reset-api`: clears customUrl, falling back to the build-time default
 *   service — or leaving the CLI unconfigured when no default was baked in
 * - `--api-url <url>`: sets a custom API URL (e.g. http://localhost:3000)
 *
 * Both clear auth tokens because they're bound to the old origin, and both
 * exit on completion so the user can re-run `b4m` with a clean auth state.
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { resolveApiEndpoint } from '../utils/apiUrl.js';

type ApiCommandOptions = { mode: 'reset' } | { mode: 'set'; url: string };

export async function handleApiCommand(options: ApiCommandOptions): Promise<void> {
  const configStore = new ConfigStore();

  if (options.mode === 'set') {
    const url = options.url.trim().replace(/\/+$/, '');

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      console.error(`❌ Invalid URL: ${url}`);
      console.error('   Example: --api-url http://localhost:3000');
      process.exit(1);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.error(`❌ Only http:// and https:// URLs are supported (got ${parsed.protocol}//)`);
      console.error('   Example: --api-url http://localhost:3000');
      process.exit(1);
    }

    await configStore.setCustomApiUrl(url);
    await configStore.clearAuthTokens();

    console.log(`\n✅ API URL set to ${url}`);
    console.log('🔓 Authentication cleared');
    console.log('💡 Run `b4m` to authenticate against the new API.\n');
    return;
  }

  await configStore.setCustomApiUrl(null);
  await configStore.clearAuthTokens();

  // After clearing the custom URL the effective endpoint is whatever the
  // build-time default resolves to — which may be nothing on a source/linked
  // checkout or unbranded fork. Report the honest state instead of implying a
  // default service always exists.
  const endpoint = resolveApiEndpoint();
  if (endpoint.status === 'configured') {
    console.log(`\n✅ Custom API URL cleared — now using the default service (${endpoint.url})`);
    console.log('🔓 Authentication cleared');
    console.log('💡 Run `b4m` to authenticate.\n');
  } else {
    console.log('\n✅ Custom API URL cleared — no default service is configured.');
    console.log('🔓 Authentication cleared');
    console.log('💡 Point the CLI at a backend:  b4m --dev  ·  b4m --api-url <url>\n');
  }
}

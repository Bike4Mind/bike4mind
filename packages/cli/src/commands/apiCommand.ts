/**
 * External API config command (--api-url / --reset-api)
 * Runs outside the interactive CLI session, before any auth flow.
 *
 * - `--reset-api`: clears customUrl, falling back to whatever the CLI resolves
 *   without one (build-time default, the source-mode local dev server, or - for
 *   a published unbranded fork - nothing, in which case `b4m` prompts for one)
 * - `--api-url <url>`: sets a custom API URL (e.g. http://localhost:3000)
 *
 * Both clear auth tokens because they're bound to the old origin, and both
 * exit on completion so the user can re-run `b4m` with a clean auth state.
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { parseApiUrl, resolveApiEndpoint } from '../utils/apiUrl.js';

type ApiCommandOptions = { mode: 'reset' } | { mode: 'set'; url: string };

export async function handleApiCommand(options: ApiCommandOptions): Promise<void> {
  const configStore = new ConfigStore();

  if (options.mode === 'set') {
    const result = parseApiUrl(options.url);
    if ('error' in result) {
      console.error(`❌ ${result.error}`);
      console.error('   Example: --api-url http://localhost:3000');
      process.exit(1);
    }
    const { url } = result;

    await configStore.setCustomApiUrl(url);
    await configStore.clearAuthTokens();

    console.log(`\n✅ API URL set to ${url}`);
    console.log('🔓 Authentication cleared');
    console.log('💡 Run `b4m` to authenticate against the new API.\n');
    return;
  }

  await configStore.setCustomApiUrl(null);
  await configStore.clearAuthTokens();

  // Report what the CLI will resolve now that the custom URL is gone, so the
  // user isn't left guessing (or surprised by a source-mode local-dev default).
  const endpoint = resolveApiEndpoint();
  console.log('\n✅ Custom API URL cleared');
  console.log('🔓 Authentication cleared');
  if (endpoint.status === 'configured') {
    console.log(`🌍 The CLI will now use ${endpoint.url}`);
    console.log('💡 Run `b4m` to authenticate.\n');
  } else {
    console.log("💡 Run `b4m` and you'll be prompted to choose a backend.\n");
  }
}

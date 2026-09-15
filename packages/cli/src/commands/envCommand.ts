/**
 * Environment switching for the `--dev` / `--prod` launch flags.
 *
 * Flipping the target persists the choice to ~/.bike4mind/config.json, so a
 * bare `b4m` always reuses whichever environment you last selected. Auth tokens
 * are cached per-environment, so flipping back and forth doesn't force a
 * re-login (see ConfigStore.switchApiEnvironment).
 */

import { ConfigStore } from '../storage/ConfigStore.js';

export type EnvTarget = 'dev' | 'prod';

/**
 * Apply a `--dev` / `--prod` launch flag: switch the persisted API environment
 * and print a concise banner describing the result. Runs before the app boots.
 */
export async function applyEnvironmentFlag(target: EnvTarget): Promise<void> {
  const configStore = new ConfigStore();
  const result = await configStore.switchApiEnvironment(target);

  if (result.changed) {
    console.log(`🔀 Switched API environment → ${result.envName} (${result.url})`);
  } else {
    console.log(`🌍 Already on ${result.envName} (${result.url})`);
  }

  if (result.authenticated) {
    console.log('   ✅ Reusing your saved login for this environment.');
  } else {
    console.log('   🔓 Not logged in here yet — run /login once the CLI starts.');
  }
  console.log('');
}

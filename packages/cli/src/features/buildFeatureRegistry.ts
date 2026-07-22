import { FeatureModuleRegistry } from './FeatureModuleRegistry.js';
import type { ICliFeatureModule } from './ICliFeatureModule.js';
import type { CliConfig } from '../storage/types.js';
import type { Logger } from '../utils/Logger.js';
import { isFeatureEnabled, type PluginDescriptor } from '../plugins/PluginStore.js';
import { findModuleProblem, makeScopedLogger } from './pluginContract.js';
import { loadPlugin } from './loadPlugin.js';

export interface BuildFeatureRegistryResult {
  registry: FeatureModuleRegistry;
  /** Names of external plugins that loaded and registered */
  loaded: string[];
  /** External plugins that were skipped, with the reason */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Build a feature registry from built-ins plus enabled external plugins.
 *
 * Deliberately side-effect-free: no ToolRouter, wsManager, or agent wiring
 * happens here because the two call sites (bootstrap and the /config
 * hot-reload in index.tsx) wire those differently. Disabled plugins are never
 * imported - their code only runs once the user turns the feature key on.
 * Every plugin failure is a skip + warning, never a throw.
 *
 * Only the interactive CLI builds a feature registry today - the headless and
 * ACP agent paths construct their agents without feature modules, so plugins
 * do not load there (same as the built-in Tavern module).
 */
export async function buildFeatureRegistry(params: {
  builtins: ICliFeatureModule[];
  descriptors: PluginDescriptor[];
  config: CliConfig;
  logger: Logger;
  /** Tool names already owned by the CLI core (non-feature-module tools). A
   *  plugin colliding with one is skipped, since tools are sent 1:1 to the
   *  provider with no dedup and a duplicate name 400s every completion. */
  reservedToolNames?: string[];
}): Promise<BuildFeatureRegistryResult> {
  const { builtins, descriptors, config, logger } = params;
  const registry = new FeatureModuleRegistry();
  const loaded: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  // Track every tool name already claimed (CLI core + built-ins + loaded
  // plugins) so a collision is caught at build time, not as a 400 mid-session.
  const claimedToolNames = new Set(params.reservedToolNames ?? []);
  for (const module of builtins) {
    registry.register(module);
    for (const tool of module.getTools()) {
      claimedToolNames.add(tool.toolSchema.name);
    }
  }

  for (const descriptor of descriptors) {
    if (!descriptor.valid) {
      skipped.push({ name: descriptor.name, reason: descriptor.reason });
      continue;
    }
    if (!isFeatureEnabled(config.features, descriptor.configKey)) {
      continue; // disabled: not an error, and never imported
    }

    const pluginLogger = makeScopedLogger(logger, descriptor.name);
    const result = await loadPlugin(descriptor, { logger: pluginLogger });
    if ('error' in result) {
      skipped.push({ name: descriptor.name, reason: result.error });
      logger.warn(`[plugin:${descriptor.name}] skipped: ${result.error}`);
      continue;
    }

    const { module } = result;
    if (registry.getModuleNames().includes(module.name)) {
      const reason = `module name '${module.name}' is already registered`;
      skipped.push({ name: descriptor.name, reason });
      logger.warn(`[plugin:${descriptor.name}] skipped: ${reason}`);
      continue;
    }

    const problem = findModuleProblem(module);
    if (problem) {
      skipped.push({ name: descriptor.name, reason: problem });
      logger.warn(`[plugin:${descriptor.name}] skipped: ${problem}`);
      continue;
    }

    // Reject a plugin whose tool names collide with an already-claimed name
    // (CLI core, a built-in, or an earlier plugin) or with each other.
    const toolNames = module.getTools().map(t => t.toolSchema.name);
    const collision =
      toolNames.find(n => claimedToolNames.has(n)) ?? toolNames.find((n, i) => toolNames.indexOf(n) !== i);
    if (collision) {
      const reason = `tool name '${collision}' collides with an existing tool`;
      skipped.push({ name: descriptor.name, reason });
      logger.warn(`[plugin:${descriptor.name}] skipped: ${reason}`);
      continue;
    }

    registry.register(module);
    toolNames.forEach(n => claimedToolNames.add(n));
    loaded.push(descriptor.name);
  }

  return { registry, loaded, skipped };
}

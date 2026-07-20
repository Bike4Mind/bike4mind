import { FeatureModuleRegistry } from './FeatureModuleRegistry.js';
import type { ICliFeatureModule } from './ICliFeatureModule.js';
import type { CliConfig } from '../storage/types.js';
import type { Logger } from '../utils/Logger.js';
import type { PluginDescriptor } from '../plugins/PluginStore.js';
import { findMalformedTool, makeScopedLogger } from './pluginContract.js';
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
 */
export async function buildFeatureRegistry(params: {
  builtins: ICliFeatureModule[];
  descriptors: PluginDescriptor[];
  config: CliConfig;
  logger: Logger;
}): Promise<BuildFeatureRegistryResult> {
  const { builtins, descriptors, config, logger } = params;
  const registry = new FeatureModuleRegistry();
  const loaded: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const module of builtins) {
    registry.register(module);
  }

  for (const descriptor of descriptors) {
    if (!descriptor.valid) {
      skipped.push({ name: descriptor.name, reason: descriptor.reason });
      continue;
    }
    if (!config.features?.[descriptor.configKey]) {
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

    const toolProblem = findMalformedTool(module);
    if (toolProblem) {
      skipped.push({ name: descriptor.name, reason: toolProblem });
      logger.warn(`[plugin:${descriptor.name}] skipped: ${toolProblem}`);
      continue;
    }

    registry.register(module);
    loaded.push(descriptor.name);
  }

  return { registry, loaded, skipped };
}

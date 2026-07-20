import { pathToFileURL } from 'url';
import type { ICliFeatureModule } from './ICliFeatureModule.js';
import type { ValidPluginDescriptor } from '../plugins/PluginStore.js';
import { type PluginContext, validateFeatureModule } from './pluginContract.js';

export type LoadPluginResult = { module: ICliFeatureModule } | { error: string };

/**
 * Import a plugin's entry module and run its factory. Never throws: every
 * failure mode (unresolvable entry, top-level throw, bad default export,
 * factory throw/reject, wrong return shape) maps to { error } so one broken
 * plugin cannot take down bootstrap. pathToFileURL keeps the dynamic import
 * working for both ESM and CJS entries from the ESM-built CLI.
 */
export async function loadPlugin(descriptor: ValidPluginDescriptor, ctx: PluginContext): Promise<LoadPluginResult> {
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(descriptor.entryAbsPath).href);
  } catch (error) {
    return { error: `failed to import entry: ${error instanceof Error ? error.message : String(error)}` };
  }

  // CJS interop can leave the factory at default.default.
  const moduleRecord = imported as { default?: unknown };
  let factory = moduleRecord.default;
  if (factory && typeof factory === 'object' && 'default' in (factory as Record<string, unknown>)) {
    factory = (factory as { default?: unknown }).default;
  }
  if (typeof factory !== 'function') {
    return { error: 'entry module must default-export a factory function' };
  }

  let candidate: unknown;
  try {
    candidate = await (factory as (ctx: PluginContext) => unknown)(ctx);
  } catch (error) {
    return { error: `factory threw: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!validateFeatureModule(candidate)) {
    return {
      error: 'factory did not return a valid feature module (name, description, getTools, getSystemPromptSection)',
    };
  }

  return { module: candidate };
}

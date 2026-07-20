import type { ICliFeatureModule } from './ICliFeatureModule.js';
import type { Logger } from '../utils/Logger.js';

/**
 * The contract between the CLI and an external plugin package.
 *
 * A plugin's entry module (b4m-plugin.entry in its package.json) default-
 * exports a factory that receives a PluginContext and returns an object
 * implementing ICliFeatureModule. Plugins cannot import @bike4mind/* packages
 * at runtime (they are bundled into the CLI, not published to node_modules),
 * so this context is the only thing the CLI hands them. Keep it minimal and
 * only ever add fields - existing plugins must keep working.
 */
export interface PluginLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginContext {
  /** Logger scoped with the plugin's name; writes to the CLI debug log. */
  logger: PluginLogger;
}

export type PluginFactory = (ctx: PluginContext) => ICliFeatureModule | Promise<ICliFeatureModule>;

export function makeScopedLogger(base: Logger, pluginName: string): PluginLogger {
  const prefix = `[plugin:${pluginName}]`;
  return {
    debug: message => base.debug(`${prefix} ${message}`),
    info: message => base.info(`${prefix} ${message}`),
    warn: message => base.warn(`${prefix} ${message}`),
    error: message => base.error(`${prefix} ${message}`),
  };
}

/** Structural check that a factory's return value honors ICliFeatureModule. */
export function validateFeatureModule(value: unknown): value is ICliFeatureModule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
    return false;
  }
  if (typeof candidate.description !== 'string') {
    return false;
  }
  if (typeof candidate.getTools !== 'function' || typeof candidate.getSystemPromptSection !== 'function') {
    return false;
  }
  for (const optional of ['getCommands', 'registerWsHandlers', 'dispose']) {
    if (candidate[optional] !== undefined && typeof candidate[optional] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Check the shape of a module's tools before registration. The registry's
 * consumers (getAllToolNames at bootstrap) read t.toolSchema.name outside any
 * per-plugin try/catch, so a malformed tool must be caught here or it crashes
 * startup.
 */
export function findMalformedTool(module: ICliFeatureModule): string | null {
  let tools: unknown;
  try {
    tools = module.getTools();
  } catch (error) {
    return `getTools() threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!Array.isArray(tools)) {
    return 'getTools() did not return an array';
  }
  for (const [index, tool] of tools.entries()) {
    const candidate = tool as { toolFn?: unknown; toolSchema?: { name?: unknown } } | null;
    if (
      !candidate ||
      typeof candidate.toolFn !== 'function' ||
      typeof candidate.toolSchema?.name !== 'string' ||
      candidate.toolSchema.name.length === 0
    ) {
      return `tool at index ${index} is malformed (needs toolFn and toolSchema.name)`;
    }
  }
  return null;
}

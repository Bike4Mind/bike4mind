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
 * Probe a plugin module before it is registered and return the first problem
 * found, or null if it is safe to register.
 *
 * The registry's consumers call getTools()/getSystemPromptSection()/
 * getCommands() OUTSIDE any per-plugin try/catch (index.tsx bootstrap, /config
 * hot-reload, and every render for autocomplete), and the registry iterates
 * modules with a bare map/flatMap - so a plugin method that throws, or a tool
 * whose schema the LLM backend rejects, would crash the CLI or 400 every
 * completion. Calling each accessor here, at load time, converts those into a
 * skip + warning (the loader's contract).
 */
export function findModuleProblem(module: ICliFeatureModule): string | null {
  const toolProblem = findToolProblem(module);
  if (toolProblem) {
    return toolProblem;
  }
  try {
    if (typeof module.getSystemPromptSection() !== 'string') {
      return 'getSystemPromptSection() did not return a string';
    }
  } catch (error) {
    return `getSystemPromptSection() threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (module.getCommands) {
    try {
      const commands = module.getCommands();
      if (!Array.isArray(commands)) {
        return 'getCommands() did not return an array';
      }
    } catch (error) {
      return `getCommands() threw: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}

/**
 * Validate the shape of a module's tools against ICompletionOptionTools
 * (b4m-core/llm-adapters). The name must be non-empty and the JSON-schema
 * parameters must be a real object schema, or the provider backend rejects the
 * whole request.
 */
function findToolProblem(module: ICliFeatureModule): string | null {
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
    const candidate = tool as { toolFn?: unknown; toolSchema?: Record<string, unknown> } | null;
    const schema = candidate?.toolSchema;
    if (!candidate || typeof candidate.toolFn !== 'function' || !schema) {
      return `tool at index ${index} is malformed (needs toolFn and toolSchema)`;
    }
    if (typeof schema.name !== 'string' || schema.name.length === 0) {
      return `tool at index ${index} is missing a toolSchema.name`;
    }
    if (typeof schema.description !== 'string') {
      return `tool '${schema.name}' is missing a string toolSchema.description`;
    }
    const params = schema.parameters as { type?: unknown; properties?: unknown } | undefined;
    // properties must be a plain object; an array is typeof 'object' but the
    // provider backend rejects it, so exclude it here to keep the load-time
    // probe from passing a schema that 400s at first invocation.
    if (
      !params ||
      params.type !== 'object' ||
      typeof params.properties !== 'object' ||
      params.properties === null ||
      Array.isArray(params.properties)
    ) {
      return `tool '${schema.name}' has invalid parameters (needs { type: 'object', properties })`;
    }
  }
  return null;
}

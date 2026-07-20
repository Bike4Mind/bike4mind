import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ICliFeatureModule, FeatureCommand } from './ICliFeatureModule.js';
import type { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager.js';
import { logger } from '../utils/Logger.js';

/**
 * Manages the lifecycle of opt-in CLI feature modules.
 *
 * Created during bootstrap, modules are conditionally registered based on config,
 * then the registry's outputs are fed into tool generation and prompt building.
 */
export class FeatureModuleRegistry {
  private readonly modules: ICliFeatureModule[] = [];

  /** Register a feature module */
  register(module: ICliFeatureModule): void {
    if (this.modules.some(m => m.name === module.name)) {
      throw new Error(`Feature module '${module.name}' is already registered`);
    }
    this.modules.push(module);
  }

  /** Collect all tools from all registered modules */
  getAllTools(): ICompletionOptionTools[] {
    return this.modules.flatMap(m => m.getTools());
  }

  /** Get all tool names from all registered modules */
  getAllToolNames(): string[] {
    return this.getAllTools().map(t => t.toolSchema.name);
  }

  /** Build combined system prompt section from all modules */
  getSystemPromptSections(): string {
    const sections = this.modules.map(m => m.getSystemPromptSection()).filter(s => s.length > 0);

    return sections.length > 0 ? '\n\n' + sections.join('\n\n') : '';
  }

  /** Register all WS handlers from all modules */
  registerAllWsHandlers(wsManager: WebSocketConnectionManager): void {
    // A plugin hook must never crash the caller (bootstrap / hot-reload); these
    // run outside any per-plugin guard and can't be probed at load time because
    // they have side effects. Isolate each module's throw.
    for (const module of this.modules) {
      try {
        module.registerWsHandlers?.(wsManager);
      } catch (error) {
        logger.warn(
          `[feature:${module.name}] registerWsHandlers threw: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /** Collect all slash commands from all registered modules */
  getAllCommands(): FeatureCommand[] {
    return this.modules.flatMap(m => m.getCommands?.() ?? []);
  }

  /** Try to execute a slash command. Returns true if handled. */
  executeCommand(name: string, args: string[]): boolean {
    for (const module of this.modules) {
      const commands = module.getCommands?.() ?? [];
      const command = commands.find(c => c.name === name);
      if (command) {
        // A throwing (or rejecting) plugin command is handled-but-failed, not
        // unhandled: swallow so it can't take down the dispatch loop or surface
        // as an unhandled rejection.
        try {
          void Promise.resolve(command.execute(args)).catch(error => {
            logger.warn(
              `[feature:${module.name}] command '${name}' failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        } catch (error) {
          logger.warn(
            `[feature:${module.name}] command '${name}' threw: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        return true;
      }
    }
    return false;
  }

  /** Cleanup all modules */
  disposeAll(): void {
    for (const module of this.modules) {
      try {
        module.dispose?.();
      } catch (error) {
        logger.warn(
          `[feature:${module.name}] dispose threw: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /** Get names of all registered modules */
  getModuleNames(): string[] {
    return this.modules.map(m => m.name);
  }

  /** Check if any modules are registered */
  get hasModules(): boolean {
    return this.modules.length > 0;
  }
}

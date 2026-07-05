import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager.js';

/**
 * A slash command provided by a feature module.
 */
export interface FeatureCommand {
  /** Command name without leading slash (e.g. 'tavern') */
  readonly name: string;
  /** Brief description shown in /help and autocomplete */
  readonly description: string;
  /** Execute the command */
  execute(args: string[]): void;
}

/**
 * Contract for opt-in CLI feature modules.
 *
 * Each module owns its own tools, prompt section, WS handlers, and
 * slash commands. The CLI core depends only on this interface - never
 * on concrete modules.
 */
export interface ICliFeatureModule {
  /** Unique module identifier (e.g. 'tavern') */
  readonly name: string;

  /** Human-readable description for system prompt context */
  readonly description: string;

  /** Tools to register with the ReAct agent */
  getTools(): ICompletionOptionTools[];

  /** Additional system prompt section (return empty string if none) */
  getSystemPromptSection(): string;

  /** Slash commands this module provides (optional) */
  getCommands?(): FeatureCommand[];

  /** Register WebSocket event handlers (optional) */
  registerWsHandlers?(wsManager: WebSocketConnectionManager): void;

  /** Cleanup on CLI exit (optional) */
  dispose?(): void;
}

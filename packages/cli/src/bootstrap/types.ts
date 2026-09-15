/**
 * Shared types for the CLI bootstrap modules.
 *
 * These modules are pure: no React hooks, no Ink, no Zustand state. This file
 * holds only the cross-module type aliases; concrete per-module Input/Result
 * interfaces live alongside their module.
 */

/** Interaction mode the agent's system prompt is built for. */
export type InteractionMode = 'normal' | 'auto-accept' | 'plan';

/** Rebuildable system-prompt factory for the current interaction mode. */
export type BuildPromptForMode = (mode: InteractionMode) => string;

/**
 * No-op logger used to keep backend logs from triggering Ink re-renders.
 * Created in the React shell and shared with the bootstrap modules.
 */
export interface SilentLogger {
  log: () => void;
  info: () => void;
  warn: () => void;
  error: () => void;
  debug: () => void;
}

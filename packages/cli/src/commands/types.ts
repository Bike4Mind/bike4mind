/**
 * Shared types for the slash-command registry.
 *
 * `CommandContext` is a focused, React-free interface: it exposes only the
 * collaborators a registered command actually needs, not the whole CLI state
 * object. This is what lets handlers be unit-tested without mounting Ink - a
 * test constructs a fake context and asserts the handler's effects. As more
 * commands migrate out of the switch in index.tsx, widen this interface with
 * the additional collaborators they require.
 */
import type { ConfigStore } from '../storage';
import type { CustomCommandStore } from '../storage/CustomCommandStore.js';
import type { PermissionManager } from '../utils';
import type { DecisionStore, BlockerStore, ReviewGateStore } from '../tools';

export interface CommandContext {
  configStore: ConfigStore;
  customCommandStore: CustomCommandStore;
  permissionManager: PermissionManager | null;
  decisionStore: DecisionStore;
  blockerStore: BlockerStore;
  reviewGateStore: ReviewGateStore;
  /** Open the interactive configuration editor (a store-backed UI action). */
  openConfigEditor: () => void;
}

export interface CommandHandler {
  name: string;
  aliases?: string[];
  run: (args: string[], ctx: CommandContext) => void | Promise<void>;
}

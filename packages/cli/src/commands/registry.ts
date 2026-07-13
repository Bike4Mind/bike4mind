/**
 * Slash-command registry and dispatcher (issue #228).
 *
 * First extraction of the command-dispatch concern out of the CLI root
 * component. `dispatch()` is transport-agnostic and React-free; commands not
 * yet migrated remain in the switch in index.tsx, which is tried only after
 * `dispatch()` reports the command was not handled here.
 */
import type { CommandContext, CommandHandler } from './types';
import { infoCommands } from './handlers/infoCommands';
import { workflowViewCommands } from './handlers/workflowViews';

export const builtinCommands: CommandHandler[] = [...infoCommands, ...workflowViewCommands];

const commandMap = new Map<string, CommandHandler>();
for (const handler of builtinCommands) {
  for (const key of [handler.name, ...(handler.aliases ?? [])]) {
    if (commandMap.has(key)) {
      throw new Error(`Duplicate command registration for "${key}"`);
    }
    commandMap.set(key, handler);
  }
}

/**
 * Route a slash-command name to its registered handler.
 *
 * @returns true if a handler ran (caller stops here), false if the command is
 *   not in the registry (caller falls through to the legacy switch).
 */
export async function dispatch(name: string, args: string[], ctx: CommandContext): Promise<boolean> {
  const handler = commandMap.get(name);
  if (!handler) return false;
  await handler.run(args, ctx);
  return true;
}

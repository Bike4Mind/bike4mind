/**
 * The slash commands the composer runs.
 *
 * A command is a CLIENT-SIDE ACTION. It is never sent to the provider, never appears as a tool
 * call, and the model cannot ask for one - and that is structural rather than a convention: this
 * registry lives in the renderer, and the tool registry lives in the main process
 * (main/chat/tools/registry.ts) behind the context bridge. There is no import that crosses from
 * one to the other, so a tool cannot reach these and a command cannot be offered as a tool
 * without someone moving a file across a process boundary and noticing why they are doing it.
 *
 * Adding a third command is one entry here plus the branch that runs it. Everything else - the
 * menu, the filtering, the keyboard, the argument - reads this list.
 */

import type { ChatSessionMode } from '@shared/chat';

export interface ComposerCommand {
  /** What the user types after the slash. Lower case, no spaces. */
  name: string;
  /** The line under the name in the menu. */
  description: string;
  /** Shown beside the name when the command takes an argument, in the menu's own grammar. */
  argumentHint?: string;
  /** Picking it from the menu fills in the name and waits for the argument instead of running it bare. */
  requiresArgument?: true;
  /** Offered only in Code sessions. Elsewhere `/name` is ordinary text, like any unknown slash. */
  codeOnly?: true;
}

export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  {
    name: 'clear',
    description: 'Start fresh. The model stops seeing what came before; nothing is deleted.',
  },
  {
    name: 'compact',
    description: 'Summarise this conversation and carry only the summary forward.',
    argumentHint: '[what to focus on]',
  },
  {
    name: 'pr',
    description: 'Show a pull request above the composer and keep its status current.',
    argumentHint: '<GitHub PR URL>',
    requiresArgument: true,
    codeOnly: true,
  },
];

function commandsFor(mode: ChatSessionMode): ComposerCommand[] {
  return COMPOSER_COMMANDS.filter(command => !command.codeOnly || mode === 'code');
}

/** The command by that exact name in a session of this mode, or undefined. Names are matched case-insensitively. */
export function findCommand(name: string, mode: ChatSessionMode): ComposerCommand | undefined {
  const needle = name.trim().toLowerCase();
  return commandsFor(mode).find(command => command.name === needle);
}

/**
 * Commands matching `query`, best first.
 *
 * Name only, and no description fallback: there are a handful and each name is the word the
 * user would reach for. The skill menu needs that fallback because a deployment can hold thirty
 * skills whose names nobody remembers; this list is read in full at a glance.
 */
export function matchCommands(query: string, mode: ChatSessionMode): ComposerCommand[] {
  const needle = query.trim().toLowerCase();
  const available = commandsFor(mode);
  if (!needle) return available;
  return available.filter(command => command.name.startsWith(needle));
}

export interface CommandInvocation {
  command: ComposerCommand;
  /** Everything after the name, trimmed. Empty when the command was run bare. */
  args: string;
}

/**
 * Read `/name args...` out of a composed draft, or null when it is not one of ours.
 *
 * Null is the important answer: a draft that starts with a slash and names no command is
 * ORDINARY TEXT and must reach the send path untouched. `/etc/hosts` is a path, `/review` is a
 * skill, and `/notacommand` is a message the user meant to send - swallowing any of the three
 * would make the composer unpredictable in exactly the way a command surface must not be.
 */
export function parseCommandInvocation(text: string, mode: ChatSessionMode): CommandInvocation | null {
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const command = findCommand(match[1], mode);
  return command ? { command, args: (match[2] ?? '').trim() } : null;
}

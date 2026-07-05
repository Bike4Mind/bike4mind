/**
 * Centralized registry of all available CLI slash commands
 */

import type { CustomCommand } from '../storage/types.js';

export interface CommandDefinition {
  /** Command name (without the leading /) */
  name: string;
  /** Brief description of what the command does */
  description: string;
  /** Optional argument placeholder (e.g., "<name>", "<tool-name>") */
  args?: string;
  /** Alternative names for the same command */
  aliases?: string[];
  /** Source of the command (built-in, global, project, or B4M-web remote) */
  source?: 'built-in' | 'global' | 'project' | 'remote';
}

export const COMMANDS: CommandDefinition[] = [
  {
    name: 'help',
    description: 'Show this help message',
  },
  {
    name: 'exit',
    description: 'Exit the CLI',
    aliases: ['quit'],
  },
  {
    name: 'login',
    description: 'Authenticate with your B4M account',
  },
  {
    name: 'logout',
    description: 'Clear authentication and sign out',
  },
  {
    name: 'whoami',
    description: 'Show current authenticated user',
  },
  {
    name: 'save',
    description: 'Save current session',
    args: '<name>',
  },
  {
    name: 'resume',
    description: 'List and resume saved sessions',
    aliases: ['sessions'],
  },
  {
    name: 'config',
    description: 'Open interactive configuration editor',
  },
  {
    name: 'set-api',
    description: 'Connect to self-hosted Bike4Mind instance',
    args: '<url>',
  },
  {
    name: 'reset-api',
    description: 'Reset to Bike4Mind main service',
  },
  {
    name: 'api-info',
    description: 'Show current API configuration',
  },
  {
    name: 'trust',
    description: "Trust a tool (won't ask permission again)",
    args: '<tool-name>',
  },
  {
    name: 'untrust',
    description: 'Remove tool from trusted list',
    args: '<tool-name>',
  },
  {
    name: 'trusted',
    description: 'List all trusted tools',
  },
  {
    name: 'usage',
    description: 'Show credit usage and balance',
  },
  {
    name: 'clear',
    description: 'Start a new session',
    aliases: ['new'],
  },
  {
    name: 'rewind',
    description: 'Rewind conversation to a previous point',
  },
  {
    name: 'undo',
    description: 'Undo the last file change',
  },
  {
    name: 'checkpoints',
    description: 'List available file restore points',
  },
  {
    name: 'restore',
    description: 'Restore files to a specific checkpoint',
    args: '<number>',
  },
  {
    name: 'diff',
    description: 'Show diff between current state and a checkpoint',
    args: '[number]',
  },
  {
    name: 'project-config',
    description: 'Show merged project configuration',
  },
  {
    name: 'commands',
    description: 'List all custom commands',
  },
  {
    name: 'commands:new',
    description: 'Create a new custom command',
    args: '<name>',
  },
  {
    name: 'commands:reload',
    description: 'Reload custom commands from disk',
  },
  {
    name: 'mcp',
    description: 'Show MCP server status and connected tools',
    aliases: ['mcp:list'],
  },
  {
    name: 'agents',
    description: 'List all available agents',
    aliases: ['agents:list'],
  },
  {
    name: 'agents:new',
    description: 'Create a new agent definition',
    args: '<name>',
  },
  {
    name: 'agents:reload',
    description: 'Reload agent definitions from disk',
  },
  {
    name: 'context',
    description: 'Show context window usage',
  },
  {
    name: 'compact',
    description: 'Compact conversation into new session',
    args: '[instructions]',
  },
  // Sandbox commands
  {
    name: 'sandbox',
    description: 'Show sandbox status and configuration',
  },
  {
    name: 'sandbox:enable',
    description: 'Enable OS-level sandbox for bash commands',
  },
  {
    name: 'sandbox:disable',
    description: 'Disable sandbox mode',
  },
  {
    name: 'sandbox:mode',
    description: 'Set sandbox mode (auto-allow or permissions)',
    args: '<auto-allow|permissions>',
  },
  {
    name: 'sandbox:trust-domain',
    description: 'Add domain(s) to the network proxy allowlist',
    args: '<domain> [...]',
  },
  {
    name: 'sandbox:domains',
    description: 'Show network proxy allowed domains',
  },
  {
    name: 'sandbox:violations',
    description: 'Show recent sandbox violations',
    args: '[count]',
  },
  {
    name: 'sandbox:violations:clear',
    description: 'Clear all recorded sandbox violations',
  },
  {
    name: 'terminal-setup',
    description: 'Configure Shift+Enter for multi-line input',
  },
  {
    name: 'add-dir',
    description: 'Add a directory for file access',
    args: '<path>',
  },
  {
    name: 'remove-dir',
    description: 'Remove a directory from file access',
    args: '<path>',
  },
  {
    name: 'dirs',
    description: 'List all accessible directories',
  },
  // Durable workflow commands
  // The standalone commands below (decisions, blockers, review-gates, handoff)
  // are equivalent to `/workflow <subcommand>` and dispatch to the same
  // handlers. They are kept as top-level shortcuts for the common case.
  {
    name: 'workflow',
    description:
      'Show workflow overview or a specific section (decisions, blockers, handoff, review-gates; `gates` alias accepted)',
    args: '[decisions|blockers|handoff|review-gates]',
  },
  {
    name: 'decisions',
    description: 'Show decision log for current session (alias for /workflow decisions)',
  },
  {
    name: 'blockers',
    description: 'Show tracked blockers for current session (alias for /workflow blockers)',
  },
  {
    name: 'review-gates',
    description: 'Show review gates for current session (alias for /workflow review-gates)',
  },
  {
    name: 'handoff',
    description:
      'Show or generate the session handoff for cross-session continuity. Use --local for an LLM-free snapshot (works when rate-limited or offline). Alias for /workflow handoff.',
    args: '[generate|--local]',
  },
];

/**
 * Get all command names including aliases
 */
export function getAllCommandNames(): string[] {
  const names: string[] = [];
  for (const cmd of COMMANDS) {
    names.push(cmd.name);
    if (cmd.aliases) {
      names.push(...cmd.aliases);
    }
  }
  return names;
}

/**
 * Find a command by name or alias
 */
export function findCommand(name: string): CommandDefinition | undefined {
  return COMMANDS.find(cmd => cmd.name === name || cmd.aliases?.includes(name));
}

/**
 * Checks if a command name is a built-in command
 * @param name - Command name to check
 * @returns true if the command is built-in
 */
export function isBuiltInCommand(name: string): boolean {
  return getAllCommandNames().includes(name);
}

/**
 * Converts a CustomCommand to a CommandDefinition for unified handling
 * @param customCommand - Custom command to convert
 * @returns CommandDefinition compatible with autocomplete and help
 */
export function customCommandToDefinition(customCommand: CustomCommand): CommandDefinition {
  return {
    name: customCommand.name,
    description: customCommand.description,
    args: customCommand.argumentHint,
    source: customCommand.source,
  };
}

/**
 * Merges custom commands and feature module commands with built-in commands.
 * Built-in commands always take precedence (custom commands cannot override them).
 *
 * @param customCommands - Array of custom commands to merge
 * @param featureCommands - Optional array of feature module command definitions
 * @returns Combined array of all command definitions
 */
export function mergeCommands(
  customCommands: CustomCommand[],
  featureCommands?: CommandDefinition[]
): CommandDefinition[] {
  const builtInCommands = COMMANDS.map(cmd => ({ ...cmd, source: 'built-in' as const }));
  const customDefinitions = customCommands
    .filter(cmd => !isBuiltInCommand(cmd.name)) // Filter out conflicts
    .map(customCommandToDefinition);

  // Log warnings for conflicting command names
  const conflicts = customCommands.filter(cmd => isBuiltInCommand(cmd.name));
  if (conflicts.length > 0) {
    console.warn(
      'Warning: The following custom commands have names that conflict with built-in commands and will be ignored:',
      conflicts.map(cmd => cmd.name).join(', ')
    );
  }

  return [...builtInCommands, ...(featureCommands ?? []), ...customDefinitions];
}

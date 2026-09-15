import Fuse from 'fuse.js';
import { COMMANDS, type CommandDefinition } from '../config/commands.js';

/**
 * Fuzzy search options for command matching
 */
const fuseOptions = {
  keys: [
    { name: 'name', weight: 0.7 }, // Prioritize command name
    { name: 'description', weight: 0.3 }, // Also search description
  ],
  threshold: 0.4, // 0 = perfect match, 1 = match anything
  includeScore: true,
  minMatchCharLength: 1,
};

/**
 * Search commands using fuzzy matching
 * @param query - The search query (without the leading /)
 * @param commands - Optional custom commands array (defaults to built-in COMMANDS)
 * @returns Array of matching commands, sorted by relevance
 */
export function searchCommands(query: string, commands: CommandDefinition[] = COMMANDS): CommandDefinition[] {
  // If query is empty, return all commands
  if (!query || query.trim() === '') {
    return commands;
  }

  const fuse = new Fuse(commands, fuseOptions);

  const results = fuse.search(query);

  return results.map(result => result.item);
}

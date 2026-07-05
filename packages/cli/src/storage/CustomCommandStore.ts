import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { CustomCommand } from './types.js';
import { parseCommandFile, extractCommandName } from '../utils/commandParser.js';
import { RemoteSkillSource } from './RemoteSkillSource.js';

/**
 * Store for managing custom slash commands
 * Discovers and loads commands from both global and project directories
 * Supports both .bike4mind/commands/ and .claude/commands/ and .claude/skills/ directories
 */
export interface CustomCommandStoreOptions {
  /** Optional remote source - when present, fetches skills from B4M web and
   *  merges them with the lowest precedence (local files always win on name
   *  collision). When omitted, the store is local-only. */
  remoteSource?: RemoteSkillSource;
}

export class CustomCommandStore {
  private commands: Map<string, CustomCommand> = new Map();
  private globalCommandsDirs: string[];
  private projectCommandsDirs: string[];
  private remoteSource?: RemoteSkillSource;

  constructor(projectRoot?: string, options: CustomCommandStoreOptions = {}) {
    this.remoteSource = options.remoteSource;
    const home = os.homedir();
    const root = projectRoot || process.cwd();

    // Global commands directories (loaded first, later directories override earlier)
    // Supports Bike4Mind commands, Claude Code commands, and Claude Code skills
    this.globalCommandsDirs = [
      path.join(home, '.bike4mind', 'commands'),
      path.join(home, '.claude', 'commands'),
      path.join(home, '.claude', 'skills'),
    ];

    // Project commands directories (loaded second, override global with same name)
    // Supports Bike4Mind commands, Claude Code commands, and Claude Code skills
    this.projectCommandsDirs = [
      path.join(root, '.bike4mind', 'commands'),
      path.join(root, '.claude', 'commands'),
      path.join(root, '.claude', 'skills'),
    ];
  }

  /**
   * Loads all custom commands from both global and project directories, then
   * layers B4M-web remote skills on top (only where names aren't already taken
   * by a local file). Local always wins - `mergeRemoteCommands()` is the
   * single source of truth for the precedence rule.
   */
  async loadCommands(): Promise<void> {
    this.commands.clear();

    // Load global commands first (bike4mind, then claude).
    for (const dir of this.globalCommandsDirs) {
      await this.loadCommandsFromDirectory(dir, 'global');
    }

    // Load project commands - these override global via map replacement.
    for (const dir of this.projectCommandsDirs) {
      await this.loadCommandsFromDirectory(dir, 'project');
    }

    // Fill in remote skills under any name not already taken by a local file.
    // No-op when no remote source is wired (constructor-time local-only use,
    // or unauthenticated CLIs).
    await this.mergeRemoteCommands();
  }

  /**
   * Attach (or replace) the remote skill source after construction. The CLI
   * boots without an `ApiClient` (auth happens later in the startup flow), so
   * the production wiring builds the source post-auth and calls
   * `mergeRemoteCommands()` here to layer remote skills in.
   */
  setRemoteSource(source: RemoteSkillSource | undefined): void {
    this.remoteSource = source;
  }

  /**
   * Fetch remote skills and merge them into the loaded map under any name
   * not already taken by a local file. The sole precedence-enforcement path -
   * `loadCommands()` calls this after the local scans, and the production CLI
   * also calls it directly post-auth (once an `ApiClient` exists).
   *
   * No-op when no remote source is wired. Errors are swallowed; remote skills
   * are a productivity boost, not a critical path.
   */
  async mergeRemoteCommands(): Promise<void> {
    if (!this.remoteSource) return;
    try {
      const remoteSkills = await this.remoteSource.fetchSkills();
      for (const skill of remoteSkills) {
        // Local always wins - only add remote entries whose name isn't taken.
        if (!this.commands.has(skill.name)) {
          this.commands.set(skill.name, skill);
        }
      }
    } catch (error) {
      if (process.env.BIKE4MIND_CLI_DEBUG) {
        console.warn(
          '[CustomCommandStore] remote skill merge failed:',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  /**
   * Reload ONLY the remote skill set, bypassing the on-disk cache. Used by a
   * future `/commands:reload-remote` handler that wants a fresh fetch without
   * re-scanning the local filesystem.
   */
  async reloadRemoteCommands(): Promise<void> {
    if (!this.remoteSource) return;
    await this.remoteSource.clearCache();
    // Drop existing remote entries so a server-side delete is reflected here.
    for (const [name, cmd] of this.commands) {
      if (cmd.source === 'remote') this.commands.delete(name);
    }
    await this.mergeRemoteCommands();
  }

  /**
   * Recursively scans a directory for .md files and loads them as commands
   *
   * @param directory - Directory to scan
   * @param source - Source identifier ('global' or 'project')
   */
  private async loadCommandsFromDirectory(directory: string, source: 'global' | 'project'): Promise<void> {
    try {
      const stats = await fs.stat(directory);
      if (!stats.isDirectory()) {
        return;
      }

      const commandFiles = await this.findCommandFiles(directory);

      for (const filePath of commandFiles) {
        try {
          await this.loadCommandFile(filePath, source);
        } catch (error) {
          console.warn(
            `Failed to load command from ${filePath}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    } catch (error) {
      // Silently ignore missing directories (ENOENT)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `Error accessing ${source} commands directory ${directory}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  /**
   * Recursively finds all .md files in a directory
   *
   * @param directory - Directory to search
   * @returns Array of full file paths to .md files
   */
  private async findCommandFiles(directory: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          const subFiles = await this.findCommandFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.warn(`Error reading directory ${directory}:`, error instanceof Error ? error.message : String(error));
    }

    return files;
  }

  /**
   * Loads a single command file
   *
   * @param filePath - Full path to the command file
   * @param source - Source identifier ('global' or 'project')
   */
  private async loadCommandFile(filePath: string, source: 'global' | 'project'): Promise<void> {
    const filename = path.basename(filePath);
    const isSkillFile = filename.toLowerCase() === 'skill.md';

    // Claude Code skills use SKILL.md with the parent directory as the command name
    // Regular commands use the filename (without .md extension) as the command name
    const commandName = isSkillFile ? this.extractSkillName(filePath) : extractCommandName(filename);

    if (!commandName) {
      console.warn(`Invalid command filename: ${filename} (must end with .md and have valid name)`);
      return;
    }

    const fileContent = await fs.readFile(filePath, 'utf-8');
    const command = parseCommandFile(fileContent, filePath, commandName, source);

    // Since global commands load first, later commands (from project directories
    // or later global directories) naturally override earlier ones by simply
    // replacing the map entry
    this.commands.set(commandName, command);
  }

  /**
   * Extracts skill name from a SKILL.md file path
   * Uses the parent directory name as the skill name
   *
   * @param filePath - Full path to the SKILL.md file
   * @returns Skill name or null if invalid
   */
  private extractSkillName(filePath: string): string | null {
    const parentDir = path.basename(path.dirname(filePath));
    // Exclude the root 'skills' directory itself
    return parentDir && parentDir !== 'skills' ? parentDir : null;
  }

  /**
   * Gets a command by name
   *
   * @param name - Command name
   * @returns CustomCommand if found, undefined otherwise
   */
  getCommand(name: string): CustomCommand | undefined {
    return this.commands.get(name);
  }

  /**
   * Gets all loaded commands
   *
   * @returns Array of all custom commands
   */
  getAllCommands(): CustomCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Gets commands filtered by source
   *
   * @param source - Filter by 'global' or 'project'
   * @returns Array of commands from the specified source
   */
  getCommandsBySource(source: CustomCommand['source']): CustomCommand[] {
    return this.getAllCommands().filter(cmd => cmd.source === source);
  }

  /**
   * Checks if a command name exists
   *
   * @param name - Command name to check
   * @returns true if command exists
   */
  hasCommand(name: string): boolean {
    return this.commands.has(name);
  }

  /**
   * Gets the number of loaded commands
   *
   * @returns Number of custom commands
   */
  getCommandCount(): number {
    return this.commands.size;
  }

  /**
   * Reloads all commands from directories
   * Useful for the /commands:reload command
   */
  async reloadCommands(): Promise<void> {
    await this.loadCommands();
  }

  /**
   * Creates a new command file from a template
   *
   * @param name - Command name
   * @param isGlobal - If true, creates in global directory, otherwise project directory
   * @returns Path to the created file
   */
  async createCommandFile(name: string, isGlobal: boolean = false): Promise<string> {
    const targetDir = isGlobal ? this.globalCommandsDirs[0] : this.projectCommandsDirs[0];
    const filePath = path.join(targetDir, `${name}.md`);

    // Check if file already exists
    const fileExists = await fs.access(filePath).then(
      () => true,
      () => false
    );
    if (fileExists) {
      throw new Error(`Command file already exists: ${filePath}`);
    }

    await fs.mkdir(targetDir, { recursive: true });

    const template = `---
description: ${name} command
argument-hint: [args]
---

# ${name}

Replace this with your command template.

You can use:
- $ARGUMENTS for all arguments
- $1, $2, etc. for positional arguments
- @filename for file references
`;

    await fs.writeFile(filePath, template, 'utf-8');

    return filePath;
  }
}

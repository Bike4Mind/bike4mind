import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';

/**
 * Command history entry in JSONL format
 */
interface HistoryEntry {
  command: string;
  timestamp: number;
}

/**
 * Maximum number of history entries to keep
 */
const MAX_HISTORY_ENTRIES = 1000;

/**
 * Manages command history stored in JSONL format
 * Uses append-friendly JSONL for efficient writes
 */
export class CommandHistoryStore {
  private historyPath: string;
  private history: string[] | null = null;

  constructor(historyPath?: string) {
    this.historyPath = historyPath || path.join(homedir(), '.bike4mind', 'history.jsonl');
  }

  /**
   * Initialize history directory
   */
  private async init(): Promise<void> {
    const dir = path.dirname(this.historyPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error('Failed to initialize history directory:', error);
      throw error;
    }
  }

  /**
   * Load command history from disk
   * Returns array of commands (newest first)
   */
  async load(): Promise<string[]> {
    if (this.history) {
      return this.history;
    }

    try {
      const data = await fs.readFile(this.historyPath, 'utf-8');
      const lines = data
        .trim()
        .split('\n')
        .filter(line => line.length > 0);

      // Parse JSONL and extract commands
      const entries: HistoryEntry[] = lines
        .map(line => {
          try {
            return JSON.parse(line) as HistoryEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is HistoryEntry => entry !== null);

      // Sort by timestamp (newest first) and extract commands
      this.history = entries.sort((a, b) => b.timestamp - a.timestamp).map(entry => entry.command);

      return this.history;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // History doesn't exist yet
        this.history = [];
        return this.history;
      }
      throw error;
    }
  }

  /**
   * Add a command to history
   * Skips if it's the same as the most recent command (deduplicate)
   */
  async add(command: string): Promise<void> {
    // Ensure history is loaded
    await this.load();

    // Skip empty commands
    if (!command || !command.trim()) {
      return;
    }

    // Skip if same as most recent command (deduplicate consecutive)
    if (this.history && this.history.length > 0 && this.history[0] === command) {
      return;
    }

    // Create entry
    const entry: HistoryEntry = {
      command,
      timestamp: Date.now(),
    };

    // Initialize directory if needed
    await this.init();

    // Append to file (JSONL format)
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(this.historyPath, line, 'utf-8');

    // Update in-memory cache (newest first)
    this.history = [command, ...(this.history || [])];

    // Trim if exceeds max
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      await this.trim();
    }
  }

  /**
   * Trim history to max entries
   * Rewrites the entire file with the most recent entries
   */
  private async trim(): Promise<void> {
    if (!this.history || this.history.length <= MAX_HISTORY_ENTRIES) {
      return;
    }

    // Keep only the most recent MAX_HISTORY_ENTRIES
    const trimmedCommands = this.history.slice(0, MAX_HISTORY_ENTRIES);

    // Create JSONL content
    const lines = trimmedCommands
      .reverse() // Reverse to maintain chronological order in file
      .map(command => {
        const entry: HistoryEntry = {
          command,
          timestamp: Date.now(), // Use current timestamp for trimmed entries
        };
        return JSON.stringify(entry);
      })
      .join('\n');

    // Rewrite file
    await fs.writeFile(this.historyPath, lines + '\n', 'utf-8');
    this.history = trimmedCommands;
  }

  /**
   * Clear all command history
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.historyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    this.history = [];
  }

  /**
   * Get all commands (newest first)
   */
  async list(): Promise<string[]> {
    return this.load();
  }
}

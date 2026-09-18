import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { Session } from './types';
import { isValidSessionId, SESSION_ID_PATTERN } from '../utils/validateSessionId.js';

/**
 * Manages conversation sessions stored as JSON files
 */
export class SessionStore {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || path.join(homedir(), '.bike4mind', 'sessions');
  }

  /**
   * A session id becomes a filesystem path component here, so validate it at the
   * sink (not only at the CLI entrypoint) - a caller reaching load/save/delete
   * with e.g. `../config` would otherwise traverse out of basePath.
   */
  private sessionFilePath(id: string): string {
    if (!isValidSessionId(id)) {
      throw new Error(`Invalid session id "${id}": must match ${SESSION_ID_PATTERN.source}`);
    }
    return path.join(this.basePath, `${id}.json`);
  }

  /**
   * Initialize storage directory
   */
  async init(): Promise<void> {
    try {
      await fs.mkdir(this.basePath, { recursive: true });
    } catch (error) {
      console.error('Failed to initialize session storage:', error);
      throw error;
    }
  }

  /**
   * Save a session to disk
   */
  async save(session: Session): Promise<void> {
    // Do not save sessions with no messages
    if (session.messages.length === 0) {
      throw new Error('Cannot save session with no messages');
    }

    await this.init();
    const filePath = this.sessionFilePath(session.id);

    try {
      await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save session:', error);
      throw error;
    }
  }

  /**
   * Load a session from disk by ID
   */
  async load(id: string): Promise<Session | null> {
    const filePath = this.sessionFilePath(id);

    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const session = JSON.parse(data) as Session;

      // Backward compatibility: Add IDs to messages that don't have them
      session.messages = session.messages.map(msg => {
        if (!msg.id) {
          return { ...msg, id: uuidv4() };
        }
        return msg;
      });

      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.error('Failed to load session:', error);
      throw error;
    }
  }

  /**
   * Load a session by name
   */
  async loadByName(name: string): Promise<Session | null> {
    const sessions = await this.list();
    const session = sessions.find(s => s.name === name);
    return session || null;
  }

  /**
   * List all saved sessions
   * @param limit - Optional limit on number of sessions to return (returns most recent)
   */
  async list(limit?: number): Promise<Session[]> {
    await this.init();

    try {
      const files = await fs.readdir(this.basePath);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      const sessionsWithFiles = await Promise.all(
        jsonFiles.map(async file => {
          const filePath = path.join(this.basePath, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const session = JSON.parse(data) as Session;

          // Backward compatibility: Add IDs to messages that don't have them
          session.messages = session.messages.map(msg => {
            if (!msg.id) {
              return { ...msg, id: uuidv4() };
            }
            return msg;
          });

          return { session, filePath };
        })
      );

      // Delete sessions with no messages and filter them out
      const validSessions: Session[] = [];
      for (const { session, filePath } of sessionsWithFiles) {
        if (session.messages.length === 0) {
          // Delete empty session file
          try {
            await fs.unlink(filePath);
          } catch (error) {
            console.error(`Failed to delete empty session ${session.id}:`, error);
          }
        } else {
          validSessions.push(session);
        }
      }

      // Sort by most recently updated
      const sorted = validSessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      // Apply limit if specified
      return limit ? sorted.slice(0, limit) : sorted;
    } catch (error) {
      console.error('Failed to list sessions:', error);
      return [];
    }
  }

  /**
   * Delete a session
   */
  async delete(id: string): Promise<boolean> {
    const filePath = this.sessionFilePath(id);

    try {
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      console.error('Failed to delete session:', error);
      throw error;
    }
  }

  /**
   * Delete a session by name
   */
  async deleteByName(name: string): Promise<boolean> {
    const session = await this.loadByName(name);
    if (!session) {
      return false;
    }
    return this.delete(session.id);
  }

  /**
   * Rename a session
   */
  async rename(id: string, newName: string): Promise<boolean> {
    const session = await this.load(id);
    if (!session) {
      return false;
    }

    session.name = newName;
    session.updatedAt = new Date().toISOString();
    await this.save(session);
    return true;
  }
}

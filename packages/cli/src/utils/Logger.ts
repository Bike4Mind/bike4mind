import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export class Logger {
  private static instance: Logger | null = null;
  private logFilePath: string | null = null;
  private sessionId: string | null = null;
  private fileLoggingEnabled: boolean = true;
  private consoleVerbose: boolean = false;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Initialize the logger with a session ID
   */
  async initialize(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    const debugDir = path.join(os.homedir(), '.bike4mind', 'debug');

    // Ensure debug directory exists
    await fs.mkdir(debugDir, { recursive: true });

    this.logFilePath = path.join(debugDir, `${sessionId}.txt`);

    // Write session start marker
    await this.writeToFile('INFO', '=== CLI SESSION START ===');
  }

  /**
   * Set whether verbose console logging is enabled
   */
  setVerbose(enabled: boolean): void {
    this.consoleVerbose = enabled;
  }

  /**
   * Set whether file logging is enabled
   */
  setFileLoggingEnabled(enabled: boolean): void {
    this.fileLoggingEnabled = enabled;
  }

  /**
   * DEBUG level - verbose-only console, always file
   */
  debug(message: string): void {
    this.writeToFile('DEBUG', message).catch(() => {});
    if (this.consoleVerbose) {
      console.log(message);
    }
  }

  /**
   * INFO level - always shown to user
   */
  info(message: string): void {
    this.writeToFile('INFO', message).catch(() => {});
    console.log(message);
  }

  /**
   * WARN level - always shown to user
   */
  warn(message: string): void {
    this.writeToFile('WARN', message).catch(() => {});
    console.warn(message);
  }

  /**
   * ERROR level - always shown to user
   */
  error(message: string, err?: unknown): void {
    this.writeToFile('ERROR', message).catch(() => {});

    if (err) {
      // Log error details to file
      this.logErrorDetailsToFile(err).catch(() => {});
    }

    console.error(message);
  }

  /**
   * Write log entry to file
   */
  private async writeToFile(level: string, message: string): Promise<void> {
    if (!this.fileLoggingEnabled || !this.logFilePath) {
      return;
    }

    try {
      const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const logEntry = `[${timestamp}] [${level}] ${message}\n`;
      await fs.appendFile(this.logFilePath, logEntry, 'utf-8');
    } catch (error) {
      // Silent fail - don't break CLI if logging fails
      console.error('File logging failed:', error);
    }
  }

  /**
   * Log error details to file
   */
  private async logErrorDetailsToFile(err: unknown): Promise<void> {
    if (!this.fileLoggingEnabled || !this.logFilePath) {
      return;
    }

    try {
      // Handle axios-like error responses
      if (err && typeof err === 'object' && 'response' in err && err.response) {
        const response = err.response as { status?: number; statusText?: string; headers?: unknown; data?: unknown };
        const config =
          err && typeof err === 'object' && 'config' in err ? (err.config as { url?: string } | undefined) : undefined;

        await this.writeToFile('ERROR', `  Status: ${response.status} ${response.statusText || ''}`);
        await this.writeToFile('ERROR', `  URL: ${config?.url || 'unknown'}`);
        await this.writeToFile('ERROR', `  Headers: ${this.safeStringify(response.headers)}`);

        if (response.data) {
          // Extract readable message from response data
          const errorText = this.extractErrorMessage(response.data);

          // Check if it's HTML
          if (errorText.trim().startsWith('<!DOCTYPE') || errorText.trim().startsWith('<html')) {
            await this.writeToFile('ERROR', `  Response Type: HTML Error Page`);

            // Try to extract meaningful error from HTML
            const parsedError = this.parseHtmlError(errorText);
            if (parsedError) {
              await this.writeToFile('ERROR', `  Error Message: ${parsedError}`);
            }

            // Log HTML with more context to see full error details
            await this.writeToFile('ERROR', `  Raw HTML: ${this.truncate(errorText, 1000)}`);
          } else {
            // Not HTML, log the error directly
            const preview = this.truncate(errorText, 500);
            await this.writeToFile('ERROR', `  Response: ${preview}`);
          }
        } else {
          await this.writeToFile('ERROR', `  Response: (no data)`);
        }
      }

      // Log stack trace if available
      if (err && typeof err === 'object' && 'stack' in err && typeof err.stack === 'string') {
        const stackLines = err.stack.split('\n').slice(0, 5).join('\n    ');
        await this.writeToFile('ERROR', `  Stack: ${stackLines}`);
      } else if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
        await this.writeToFile('ERROR', `  Message: ${err.message}`);
      }
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Safely stringify object, handling circular references
   */
  private safeStringify(obj: unknown): string {
    try {
      return JSON.stringify(obj);
    } catch (error) {
      // Handle circular references
      if (error instanceof Error && error.message.includes('circular')) {
        try {
          // Use a replacer function to handle circular refs
          const seen = new WeakSet();
          return JSON.stringify(obj, (key, value) => {
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) {
                return '[Circular]';
              }
              seen.add(value);
            }
            return value;
          });
        } catch {
          return '[Unable to stringify]';
        }
      }
      return '[Stringify error]';
    }
  }

  /**
   * Extract readable text from error response data
   */
  private extractErrorMessage(data: unknown): string {
    // If it's a Buffer (common with axios), convert to string
    if (Buffer.isBuffer(data)) {
      return data.toString('utf-8');
    }

    // If it's already a string, return it
    if (typeof data === 'string') {
      return data;
    }

    // If it's an object with _readableState (stream), try to get buffer data
    if (
      data &&
      typeof data === 'object' &&
      '_readableState' in data &&
      data._readableState &&
      typeof data._readableState === 'object' &&
      'buffer' in data._readableState &&
      Array.isArray(data._readableState.buffer) &&
      data._readableState.buffer.length > 0
    ) {
      const chunks: Buffer[] = [];

      for (const chunk of data._readableState.buffer) {
        // Handle {type: "Buffer", data: [numbers]} format (JSON serialized Buffer)
        if (
          chunk &&
          typeof chunk === 'object' &&
          'type' in chunk &&
          chunk.type === 'Buffer' &&
          'data' in chunk &&
          Array.isArray(chunk.data)
        ) {
          chunks.push(Buffer.from(chunk.data));
        }
        // Handle actual Buffer objects
        else if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
        }
        // Handle chunk.data that's a Buffer or array
        else if (chunk && typeof chunk === 'object' && 'data' in chunk) {
          if (Buffer.isBuffer(chunk.data)) {
            chunks.push(chunk.data);
          } else if (Array.isArray(chunk.data)) {
            chunks.push(Buffer.from(chunk.data));
          }
        }
      }

      if (chunks.length > 0) {
        return Buffer.concat(chunks).toString('utf-8');
      }
    }

    // Otherwise stringify
    return this.safeStringify(data);
  }

  /**
   * Parse HTML error page to extract error message
   */
  private parseHtmlError(html: string): string | null {
    // Try to extract error from common patterns
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const h1Match = html.match(/<h1>(.*?)<\/h1>/i);
    const bodyMatch = html.match(/<body[^>]*>(.*?)<\/body>/is);

    if (titleMatch && titleMatch[1] !== 'Error') {
      return titleMatch[1].trim();
    }

    if (h1Match) {
      return h1Match[1].trim();
    }

    if (bodyMatch) {
      // Strip HTML tags and get first meaningful line
      const text = bodyMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text.substring(0, 200);
    }

    return null;
  }

  /**
   * Truncate string to max length with ellipsis
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) {
      return str;
    }
    return str.substring(0, maxLength) + '... [truncated]';
  }

  /**
   * Format bytes to human-readable size
   */
  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Clean up old debug logs (older than 30 days)
   */
  async cleanupOldLogs(): Promise<void> {
    if (!this.fileLoggingEnabled) return;

    try {
      const debugDir = path.join(os.homedir(), '.bike4mind', 'debug');
      const files = await fs.readdir(debugDir);
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

      for (const file of files) {
        const filePath = path.join(debugDir, file);
        const stats = await fs.stat(filePath);

        if (stats.mtime.getTime() < thirtyDaysAgo) {
          await fs.unlink(filePath);
        }
      }
    } catch (error) {
      // Silent fail
      console.error('Failed to cleanup old logs:', error);
    }
  }
}

// Export singleton instance
export const logger = Logger.getInstance();
logger.setVerbose(process.env.B4M_VERBOSE === '1');

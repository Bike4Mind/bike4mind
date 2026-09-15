/**
 * Logger interface for dependency injection
 * Defines the contract for logging implementations
 */
export interface ILogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
  withMetadata?(metadata: Record<string, unknown>): ILogger;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger implements ILogger {
  static globalInstance = new Logger();
  protected metadata: Record<string, unknown> = {};
  protected logInJson: boolean;
  protected prettyPrint: boolean;
  protected minLevel: LogLevel;

  // Log level hierarchy (higher number = more severe)
  private static readonly LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  // ANSI color codes for pretty printing
  private static readonly COLORS = {
    debug: '\x1b[36m', // Cyan
    info: '\x1b[32m', // Green
    warn: '\x1b[33m', // Yellow
    error: '\x1b[31m', // Red
    reset: '\x1b[0m',
    dim: '\x1b[2m',
  } as const;

  // Level labels for pretty printing (padded for alignment)
  private static readonly LEVEL_LABELS: Record<LogLevel, string> = {
    debug: 'DEBUG',
    info: ' INFO',
    warn: ' WARN',
    error: 'ERROR',
  };

  // Indentation constants for pretty printing
  private static readonly INDENT = '    ';
  private static readonly NESTED_INDENT = '      ';

  constructor(
    options: {
      metadata?: Record<string, unknown>;
      logInJson?: boolean;
      prettyPrint?: boolean;
      minLevel?: LogLevel;
    } = {}
  ) {
    // Detect local development: IS_LOCAL, NODE_ENV=development, or SST live mode
    const isLocalDev =
      process.env.IS_LOCAL === 'true' || process.env.NODE_ENV === 'development' || process.env.SST_LIVE === 'true';

    const {
      metadata = {},
      logInJson = process.env.LOG_JSON === 'true' || !isLocalDev,
      prettyPrint = isLocalDev && process.env.LOG_PRETTY !== 'false',
      minLevel = (process.env.LOG_LEVEL as LogLevel) || 'info',
    } = options;

    this.metadata = metadata;
    this.logInJson = logInJson;
    this.prettyPrint = prettyPrint;
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return Logger.LOG_LEVELS[level] >= Logger.LOG_LEVELS[this.minLevel];
  }

  /**
   * Safely stringify a value, handling circular references
   */
  private safeStringify(value: unknown, indent?: number): string {
    try {
      return JSON.stringify(value, null, indent);
    } catch {
      return '[Circular]';
    }
  }

  /**
   * Parse log arguments to extract message and optional metadata
   */
  private parseArgs(args: unknown[], errorAware = false): { message: string; metadata?: Record<string, unknown> } {
    if (args.length === 0) {
      return { message: '' };
    }

    const lastArg = args[args.length - 1];
    const hasMetadata =
      args.length > 1 &&
      typeof lastArg === 'object' &&
      lastArg !== null &&
      !Array.isArray(lastArg) &&
      !(lastArg instanceof Error);

    const metadata = hasMetadata ? (lastArg as Record<string, unknown>) : undefined;
    const messageArgs = hasMetadata ? args.slice(0, -1) : args;

    const message = messageArgs
      .map(a => {
        if (errorAware && a instanceof Error) {
          return a.stack || a.message;
        }
        return typeof a === 'string' ? a : this.safeStringify(a);
      })
      .join(' ');

    return { message, metadata };
  }

  /**
   * Output a log message using the appropriate format
   */
  private output(
    level: LogLevel,
    consoleFn: (...args: unknown[]) => void,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    const allMetadata = { ...this.metadata, ...metadata };

    if (this.logInJson) {
      // Cloud/AWS - structured JSON
      consoleFn(this.safeStringify({ ...allMetadata, severity: level, message }));
    } else if (this.prettyPrint) {
      // Local dev - pino-pretty-like formatted output
      consoleFn(this.formatPretty(level, message, metadata));
    } else {
      // Plain text fallback - include metadata if present
      const metadataKeys = Object.keys(allMetadata);
      if (metadataKeys.length > 0) {
        consoleFn(message, allMetadata);
      } else {
        consoleFn(message);
      }
    }
  }

  /**
   * Format a log message with pino-pretty-like output for local development
   */
  private formatPretty(level: LogLevel, message: string, metadata?: Record<string, unknown>): string {
    const { reset, dim } = Logger.COLORS;
    const color = Logger.COLORS[level];

    const timestamp = new Date().toISOString();
    const parts: string[] = [];

    // Level and timestamp on first line with message
    parts.push(`${dim}[${timestamp}]${reset} ${color}${Logger.LEVEL_LABELS[level]}${reset} ${message}`);

    // Metadata on separate indented lines (if present and not empty)
    const allMetadata = { ...this.metadata, ...metadata };
    const metadataKeys = Object.keys(allMetadata);
    if (metadataKeys.length > 0) {
      for (const key of metadataKeys) {
        const value = allMetadata[key];

        if (typeof value === 'object' && value !== null) {
          // For objects/arrays, use JSON.stringify with indentation
          const jsonStr = this.safeStringify(value, 2);
          // Indent each line of the JSON
          const indentedJson = jsonStr
            .split('\n')
            .map((line, idx) => (idx === 0 ? line : Logger.NESTED_INDENT + line))
            .join('\n');
          parts.push(`${Logger.INDENT}${dim}${key}:${reset} ${indentedJson}`);
        } else {
          // For primitives, simple key: value format
          parts.push(`${Logger.INDENT}${dim}${key}:${reset} ${value}`);
        }
      }
    }

    return parts.join('\n');
  }

  public resetMetadata() {
    this.metadata = {};
    return this;
  }

  public withMetadata(metadata: Record<string, unknown>) {
    return new Logger({
      metadata: {
        ...this.metadata,
        ...metadata,
      },
      logInJson: this.logInJson,
      prettyPrint: this.prettyPrint,
      minLevel: this.minLevel,
    });
  }

  public updateMetadata(metadata: Record<string, unknown>) {
    this.metadata = {
      ...this.metadata,
      ...metadata,
    };
    return this;
  }

  public log(...args: unknown[]) {
    return this.info(...args);
  }

  public debug(...args: unknown[]) {
    if (!this.shouldLog('debug')) return;
    const { message, metadata } = this.parseArgs(args);
    this.output('debug', console.debug, message, metadata);
  }

  public info(...args: unknown[]) {
    if (!this.shouldLog('info')) return;
    const { message, metadata } = this.parseArgs(args);
    this.output('info', console.info, message, metadata);
  }

  public warn(...args: unknown[]) {
    if (!this.shouldLog('warn')) return;
    const { message, metadata } = this.parseArgs(args);
    this.output('warn', console.warn, message, metadata);
  }

  public error(...args: unknown[]) {
    if (!this.shouldLog('error')) return;
    const { message, metadata } = this.parseArgs(args, true);
    this.output('error', console.error, message, metadata);
  }

  /*
   * Global logger instance handling:
   */

  /** @deprecated: use Logger.log instance method instead */
  public static log(...args: unknown[]) {
    return Logger.globalInstance.log(...args);
  }

  /** @deprecated: use Logger.debug instance method instead */
  public static debug(...args: unknown[]) {
    return Logger.globalInstance.debug(...args);
  }

  /** @deprecated: use Logger.info instance method instead */
  public static info(...args: unknown[]) {
    return Logger.globalInstance.info(...args);
  }

  /** @deprecated: use Logger.warn instance method instead */
  public static warn(...args: unknown[]) {
    return Logger.globalInstance.warn(...args);
  }

  /** @deprecated: use Logger.error instance method instead */
  public static error(...args: unknown[]) {
    return Logger.globalInstance.error(...args);
  }

  /**
   * Update tags for all log following log messages (until resetMetadata()):
   * @deprecated: Use Logger.withMetadata() instead
   */
  public static updateMetadata(metadata: Record<string, unknown>) {
    return Logger.globalInstance.updateMetadata(metadata);
  }

  /**
   * Temporarily add tags for log messages descended from the returned handle:
   * @deprecated: Use Logger.withMetadata() instead
   */
  public static withMetadata(metadata: Record<string, unknown>) {
    return Logger.globalInstance.withMetadata(metadata);
  }

  /**
   * Reset tags associated with the global logger instance:
   * @deprecated: Don't use the global logger instance; use Logger injected from caller instead
   */
  public static resetMetadata() {
    return Logger.globalInstance.resetMetadata();
  }

  public setLevel(level: LogLevel) {
    this.minLevel = level;
    return this;
  }

  public static colorize = (...args: string[]) => ({
    black: `\x1b[30m${args.join(' ')}\x1b[0m`,
    red: `\x1b[31m${args.join(' ')}\x1b[0m`,
    green: `\x1b[32m${args.join(' ')}\x1b[0m`,
    yellow: `\x1b[33m${args.join(' ')}\x1b[0m`,
    blue: `\x1b[34m${args.join(' ')}\x1b[0m`,
  });
}

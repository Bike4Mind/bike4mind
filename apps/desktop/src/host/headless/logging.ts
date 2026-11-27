import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs';
import type { AuthLogger } from '@bike4mind/client-auth';
import { redact } from '../../main/devlog/redact';

export type HostLogger = AuthLogger;

export const LOG_FILE_NAME = 'host.log';
const OWNER_ONLY_FILE = 0o600;

type Level = 'DEBUG' | 'WARN' | 'ERROR';

const describe = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err));

function line(level: Level, message: string, err?: unknown): string {
  const suffix = err === undefined ? '' : `: ${describe(err)}`;
  return `${new Date().toISOString()} ${level} ${redact(`${message}${suffix}`)}\n`;
}

/** Lines to stderr: what `connect` and the short commands write, since their stdout belongs to the protocol or to output. */
export function createStderrLogger(verbose: boolean): HostLogger {
  const write = (level: Level, message: string, err?: unknown) => process.stderr.write(line(level, message, err));
  return {
    debug: message => {
      if (verbose) write('DEBUG', message);
    },
    warn: message => write('WARN', message),
    error: (message, err) => write('ERROR', message, err),
  };
}

export type FileLoggerOptions = {
  path: string;
  verbose: boolean;
  /** The file is rotated once it passes this size. */
  maxBytes?: number;
  /** Rotated files kept beside it: `host.log.1` is the newest. */
  keep?: number;
};

/**
 * The daemon's log: appended synchronously so the last line before a crash is on disk, owner-only
 * since it names folders and sessions, and rotated by size so a host left running for months
 * holds a bounded amount. A write that fails is dropped rather than thrown into the runtime.
 */
export function createFileLogger(options: FileLoggerOptions): HostLogger {
  const { path, verbose, maxBytes = 5 * 1024 * 1024, keep = 3 } = options;
  let size = currentSize(path);

  const rotate = () => {
    rmSync(`${path}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index--) {
      try {
        renameSync(`${path}.${index}`, `${path}.${index + 1}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    try {
      renameSync(path, `${path}.1`);
    } catch (err) {
      // Already rotated by another process: start counting from the fresh file.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    size = 0;
  };

  const write = (level: Level, message: string, err?: unknown) => {
    const text = line(level, message, err);
    try {
      if (size > 0 && size + Buffer.byteLength(text) > maxBytes) rotate();
      appendFileSync(path, text, { mode: OWNER_ONLY_FILE });
      size += Buffer.byteLength(text);
    } catch {
      // Nowhere left to report it: stderr of a detached daemon is this same file.
    }
  };

  return {
    debug: message => {
      if (verbose) write('DEBUG', message);
    },
    warn: message => write('WARN', message),
    error: (message, err) => write('ERROR', message, err),
  };
}

function currentSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { redact } from './devlog/redact';

export const LOG_FILE_NAME = 'main.log';
/** The previous file, kept so a rotation does not throw away the lines that led up to it. */
export const ROTATED_LOG_FILE_NAME = 'main.old.log';
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** The file operations this needs, narrowed so the sink can be tested without a disk. */
export interface LogFileSystem {
  ensureDirectory(path: string): void;
  /** Size in bytes, or 0 when the file does not exist yet. */
  size(path: string): number;
  append(path: string, contents: string): void;
  rename(from: string, to: string): void;
}

const nodeFileSystem: LogFileSystem = {
  ensureDirectory: path => mkdirSync(path, { recursive: true }),
  size: path => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  },
  append: (path, contents) => appendFileSync(path, contents, { encoding: 'utf8', mode: 0o600 }),
  rename: (from, to) => renameSync(from, to),
};

type ConsoleLike = Pick<Console, 'warn' | 'error'>;

/**
 * Copy every main-process `console.warn` / `console.error` into `<directory>/main.log`, so a
 * packaged build - which has no terminal - still leaves a record of why it signed someone out.
 *
 * Each line carries the pid: two app instances can share one `userData` and so one vault, and
 * telling their lines apart is most of diagnosing that. Lines are scrubbed with the dev log's
 * {@link redact} on the way in. Writes are synchronous because warnings are rare and the line
 * written just before a crash is the one most worth having.
 *
 * Returns a function that puts the original console methods back.
 */
export function persistConsoleWarnings(
  target: ConsoleLike,
  directory: string,
  fs: LogFileSystem = nodeFileSystem,
  pid: number = process.pid
): () => void {
  const path = join(directory, LOG_FILE_NAME);
  const original = { warn: target.warn, error: target.error };
  let failed = false;
  let bytes = 0;

  try {
    fs.ensureDirectory(directory);
    bytes = fs.size(path);
  } catch (err) {
    failed = true;
    original.error.call(target, `LOG: cannot open ${path}, warnings will not be persisted`, err);
  }

  const write = (level: 'warn' | 'error', args: unknown[]) => {
    if (failed) return;
    const line = `${new Date().toISOString()} [${level}] [pid ${pid}] ${redact(format(...args))}\n`;
    try {
      if (bytes + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        fs.rename(path, join(directory, ROTATED_LOG_FILE_NAME));
        bytes = 0;
      }
      fs.append(path, line);
      bytes += Buffer.byteLength(line);
    } catch (err) {
      // Said once on the real console and then dropped: reporting it through the patched
      // methods would recurse, and a full disk would turn every warning into two.
      failed = true;
      original.error.call(target, `LOG: writing ${path} failed, warnings will no longer be persisted`, err);
    }
  };

  target.warn = (...args: unknown[]) => {
    original.warn.apply(target, args);
    write('warn', args);
  };
  target.error = (...args: unknown[]) => {
    original.error.apply(target, args);
    write('error', args);
  };

  return () => {
    target.warn = original.warn;
    target.error = original.error;
  };
}

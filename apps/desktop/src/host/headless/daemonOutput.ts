import { openSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Imported statically by cli.ts, so node builtins only (see the note there).

/**
 * A detached daemon's raw stdout and stderr: what reaches no logger, such as a fatal error from
 * Node itself. Kept apart from `host.log` (see logging.ts), whose logger rotates by rename and
 * must be that file's only writer; an inherited descriptor would follow the renamed file.
 */
export const DAEMON_OUTPUT_FILE_NAME = 'daemon-output.log';

/**
 * Opens a fresh output file for the daemon about to start, keeping the previous run's as `.1`
 * so the trace of the crash that led to this start survives it. Returns the descriptor, which
 * the caller closes once the child holds it.
 */
export function openDaemonOutput(dataDirectory: string): number {
  const path = join(dataDirectory, DAEMON_OUTPUT_FILE_NAME);
  try {
    renameSync(path, `${path}.1`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return openSync(path, 'w', 0o600);
}

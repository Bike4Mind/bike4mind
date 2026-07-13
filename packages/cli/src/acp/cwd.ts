/**
 * Working-directory validation for ACP sessions.
 *
 * The client supplies a `cwd` on session/new and session/load. Because the CLI
 * file tools resolve paths against `process.cwd()`, that directory becomes the
 * file-tool root for the session. We validate it up front and fail loud with a
 * protocol error rather than letting a bad path surface as opaque tool errors
 * later.
 */

import { existsSync, statSync, realpathSync } from 'fs';
import { isAbsolute } from 'path';
import { RequestError } from './acpSdk.js';

/**
 * Validate a client-supplied session cwd and return its canonical (symlink-
 * resolved) absolute path. Throws an ACP invalid-params error if the path is
 * not absolute, does not exist, or is not a directory.
 */
export function assertConfinedCwd(cwd: string): string {
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) {
    throw RequestError.invalidParams(undefined, `Session cwd must be an absolute path, got: ${JSON.stringify(cwd)}`);
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw RequestError.invalidParams(undefined, `Session cwd is not an existing directory: ${cwd}`);
  }
  return realpathSync(cwd);
}

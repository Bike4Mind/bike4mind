import { access, constants } from 'fs/promises';

export interface RipgrepStatus {
  available: boolean;
  path?: string;
  error?: string;
}

/**
 * Probe `@vscode/ripgrep` the same way `grep_search` does: dynamic-import the
 * package, take its exported `rgPath`, and verify it's executable on disk.
 * The package is an optional dependency, so any failure mode (missing package,
 * missing platform sibling, missing binary) is reported as `available: false`.
 */
export async function checkRipgrep(): Promise<RipgrepStatus> {
  let rgPath: string | undefined;
  try {
    ({ rgPath } = (await import('@vscode/ripgrep')) as { rgPath?: string });
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!rgPath) {
    return { available: false, error: '@vscode/ripgrep did not export rgPath' };
  }

  try {
    await access(rgPath, constants.X_OK);
    return { available: true, path: rgPath };
  } catch {
    return { available: false, path: rgPath, error: `binary not executable at ${rgPath}` };
  }
}

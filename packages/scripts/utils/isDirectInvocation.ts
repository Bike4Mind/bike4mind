import * as fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * True when this module is the script node was launched on (as opposed to being
 * imported by a test or another script). Compares real paths, not the filename
 * suffix or the raw argv path: node resolves symlinks in import.meta.url but leaves
 * process.argv[1] as typed, so a plain equality check silently no-ops the CLI when
 * it is launched through a symlinked directory.
 *
 * Lives here rather than in a shared utils.ts because that file is bundled into the
 * client, which cannot import fs.
 */
export function isDirectInvocation(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

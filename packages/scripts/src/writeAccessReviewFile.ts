import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Publish privately even when replacing a file with broader permissions or a symlink. */
export function writeAccessReviewFile(destination: string, contents: string): void {
  const temporaryDirectory = mkdtempSync(join(dirname(destination), '.access-review-'));
  try {
    const temporaryFile = join(temporaryDirectory, 'report');
    writeFileSync(temporaryFile, contents, { mode: 0o600 });
    renameSync(temporaryFile, destination);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

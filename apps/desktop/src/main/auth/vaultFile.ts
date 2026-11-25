import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VaultFile } from './tokenVault';

/**
 * The credential vault's file on disk, written owner-only (0600). Electron-free: the desktop
 * app (main/auth/index.ts) and the headless host (host/auth/HeadlessHostAuth.ts) both use it.
 */
export function createVaultFile(path: string): VaultFile {
  return {
    async read() {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(contents) {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: a crash mid-write would otherwise leave a truncated vault, which
      // reads back as corrupt and silently signs the user out of every environment at once.
      // Per process: two instances sharing this userData must not rename each other's half-written file.
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

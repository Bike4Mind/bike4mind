import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PrivateFile {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

/**
 * A userData file written the same way the auth vault is: mode 0600 and write-then-rename,
 * because a crash mid-write would otherwise leave it truncated.
 */
export function privateFile(path: string): PrivateFile {
  return {
    read: async () => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    write: async contents => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

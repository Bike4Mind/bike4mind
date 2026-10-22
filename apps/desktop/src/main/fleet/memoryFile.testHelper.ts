import type { VaultFile } from '../auth/tokenVault';

export type MemoryFile = VaultFile & { contents: string | null };

/** An in-memory VaultFile; `slowWrites` defers each write a macrotask so overlapping callers can interleave. */
export function memoryFile(initial: string | null = null, slowWrites = false): MemoryFile {
  return {
    contents: initial,
    async read() {
      return this.contents;
    },
    async write(contents: string) {
      if (slowWrites) await new Promise(resolve => setTimeout(resolve, 0));
      this.contents = contents;
    },
  };
}

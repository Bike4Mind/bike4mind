import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./paths', async importOriginal => {
  const actual = await importOriginal<typeof import('./paths')>();
  return {
    ...actual,
    resolveWithinRootsPhysically: async (requested: string, roots: readonly string[], base: string) => {
      if (requested.includes('unresolved')) throw new actual.PathAccessDenied(requested);
      return actual.resolveWithinRootsPhysically(requested, roots, base);
    },
  };
});

const { scanShell } = await import('./shellScan');

describe('an operand that cannot be resolved', () => {
  const root = join(tmpdir(), 'b4m-scan-unresolved');

  // A WSL folder whose distro gives no answer reaches the scan the same way.
  it('fails the scan, so the command is asked about, instead of recording the path as written', async () => {
    await expect(scanShell('sed -n p unresolved.txt', root, [root])).rejects.toThrow();
    await expect(scanShell('sed -n p resolved.txt', root, [root])).resolves.not.toBeNull();
  });
});

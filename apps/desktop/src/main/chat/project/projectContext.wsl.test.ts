import { describe, expect, it, vi } from 'vitest';

vi.mock('./git', () => ({ git: async () => 'a\\b/c.txt\0x?y.md\0' }));
vi.mock('./memory', () => ({ memoryStoreFor: async () => undefined }));
vi.mock('./instructions', () => ({
  defaultUserInstructionsRoot: () => '/nowhere',
  loadInstructions: async () => [],
}));
vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  return { ...actual, wslLocation: (directory: string) => actual.parseWslPath(directory) };
});

const { loadProjectContext } = await import('./projectContext');

describe('the project tree for names git lists', () => {
  it('shows names in a WSL folder as the share spells them, as glob and grep do', async () => {
    const tree = await loadProjectContext('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj');

    expect(tree).toContain('a\u{f05c}b/ (1 file)');
    expect(tree).toContain('x\u{f03f}y.md');
    expect(tree).not.toContain('x?y.md');
  });

  it('keeps names elsewhere as git printed them', async () => {
    const tree = await loadProjectContext('/home/me/proj');

    expect(tree).toContain('a\\b/ (1 file)');
    expect(tree).toContain('x?y.md');
  });
});

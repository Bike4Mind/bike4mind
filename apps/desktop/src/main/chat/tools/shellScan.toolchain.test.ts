import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanShell } from './shellScan';

let home = '';
vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => home,
}));

describe('toolchain probes when the home folder is reached through a link', () => {
  let base: string;

  beforeEach(async () => {
    // Not under the temp folders, which a scan always allows.
    base = await realpath(await mkdtemp(join(process.cwd(), '.b4m-toolchain-')));
    await mkdir(join(base, 'real', 'proj'), { recursive: true });
    await symlink(join(base, 'real'), join(base, 'home'));
    home = join(base, 'home');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const directories = async (command: string) => {
    const root = join(home, 'proj');
    return (await scanShell(command, root, [root]))?.directories;
  };

  it('treats a toolchain folder that does not exist yet as a toolchain folder', async () => {
    expect(await directories('ls ~/.nvm/versions')).toEqual([]);
  });

  it('still asks when a toolchain folder holds a link to a secret folder', async () => {
    await mkdir(join(base, 'real', '.ssh'));
    await mkdir(join(base, 'real', '.nvm'));
    await writeFile(join(base, 'real', '.ssh', 'id_rsa'), 'KEY');
    await symlink(join(base, 'real', '.ssh'), join(base, 'real', '.nvm', 'link'));
    expect(await directories('cat ~/.nvm/link/id_rsa')).not.toEqual([]);
  });
});

describe('toolchain probes when a folder above the home folder is named like a secret', () => {
  let base: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(process.cwd(), '.b4m-token-')));
    await mkdir(join(base, 'home', 'proj'), { recursive: true });
    home = join(base, 'home');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const directories = async (command: string) => {
    const root = join(home, 'proj');
    return (await scanShell(command, root, [root]))?.directories;
  };

  it('still treats a toolchain folder as a toolchain folder', async () => {
    expect(await directories('ls ~/.nvm/versions')).toEqual([]);
  });

  it('still asks about a secret-named file inside the toolchain folder', async () => {
    await mkdir(join(home, '.nvm', 'versions'), { recursive: true });
    await writeFile(join(home, '.nvm', 'versions', 'token.json'), '{}');
    expect(await directories('cat ~/.nvm/versions/token.json')).not.toEqual([]);
  });
});

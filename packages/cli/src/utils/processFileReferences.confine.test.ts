import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { processFileReferences } from './processFileReferences';
import { mkdtemp, writeFile, rm, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Real filesystem (no fs mock) so the shared realpath validator resolves paths.
describe('processFileReferences @file confinement', () => {
  let dir: string;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    dir = await realpath(await mkdtemp(join(tmpdir(), 'pfr-confine-')));
    process.chdir(dir);
    await writeFile(join(dir, 'ok.txt'), 'inside-workspace-content');
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it('denies an absolute @file outside the workspace when confined (skill body)', async () => {
    const res = await processFileReferences('see @/etc/passwd', []);
    expect(res.errors.join(' ')).toMatch(/Access denied/);
    expect(res.content).not.toContain('root:');
  });

  it('allows an in-workspace @file when confined', async () => {
    const res = await processFileReferences('see @ok.txt', []);
    expect(res.errors).toHaveLength(0);
    expect(res.content).toContain('inside-workspace-content');
  });

  it('stays permissive for user-typed input (no confine list)', async () => {
    const res = await processFileReferences('see @ok.txt');
    expect(res.content).toContain('inside-workspace-content');
  });
});

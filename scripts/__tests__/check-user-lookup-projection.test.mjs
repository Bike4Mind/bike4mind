import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walk } from '../check-user-lookup-projection.mjs';

const dirs = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-lookup-walk-'));
  dirs.push(root);
  return root;
}

describe('walk', () => {
  it('skips dangling and looping symlinks and still yields real files', () => {
    const root = makeTree();
    fs.writeFileSync(path.join(root, 'a.ts'), '');
    fs.writeFileSync(path.join(root, 'a.test.ts'), '');
    fs.symlinkSync(path.join(root, 'missing.ts'), path.join(root, 'dangling.ts'));
    fs.symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
    fs.symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'));

    expect([...walk(root)]).toEqual([path.join(root, 'a.ts')]);
  });

  it('still follows valid symlinks', () => {
    const root = makeTree();
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'b.ts'), '');
    fs.symlinkSync(real, path.join(root, 'link'));

    expect([...walk(root)].sort()).toEqual([path.join(root, 'link', 'b.ts'), path.join(real, 'b.ts')].sort());
  });
});

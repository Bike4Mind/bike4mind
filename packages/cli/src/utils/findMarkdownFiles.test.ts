import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { findMarkdownFiles } from './findMarkdownFiles.js';

describe('findMarkdownFiles', () => {
  let root: string;
  let store: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'find-md-'));
    store = await fs.mkdtemp(path.join(os.tmpdir(), 'find-md-store-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(store, { recursive: true, force: true });
  });

  it('finds plain .md files recursively and ignores other extensions', async () => {
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'top.md'), 'top');
    await fs.writeFile(path.join(root, 'nested', 'deep.md'), 'deep');
    await fs.writeFile(path.join(root, 'notes.txt'), 'ignored');

    const found = await findMarkdownFiles(root);

    expect(found.sort()).toEqual([path.join(root, 'nested', 'deep.md'), path.join(root, 'top.md')].sort());
  });

  it('optionally skips hidden directories without hiding dotfiles in visible directories', async () => {
    await fs.mkdir(path.join(root, '.trash'));
    await fs.mkdir(path.join(root, 'visible'));
    await fs.writeFile(path.join(root, '.trash', 'deleted.md'), 'deleted');
    await fs.writeFile(path.join(root, 'visible', '.notes.md'), 'notes');

    const all = await findMarkdownFiles(root);
    const withoutHiddenDirectories = await findMarkdownFiles(root, undefined, { skipHiddenDirectories: true });

    expect(all.sort()).toEqual(
      [path.join(root, '.trash', 'deleted.md'), path.join(root, 'visible', '.notes.md')].sort()
    );
    expect(withoutHiddenDirectories).toEqual([path.join(root, 'visible', '.notes.md')]);
  });

  // The real-world case: nix home-manager / chezmoi symlink SKILL.md into an
  // immutable store, and a Dirent for a symlink is neither file nor directory.
  it('follows a symlinked .md file', async () => {
    const target = path.join(store, 'SKILL.md');
    await fs.writeFile(target, '# skill');
    await fs.mkdir(path.join(root, 'ship'));
    await fs.symlink(target, path.join(root, 'ship', 'SKILL.md'));

    const found = await findMarkdownFiles(root);

    expect(found).toEqual([path.join(root, 'ship', 'SKILL.md')]);
  });

  it('follows a symlinked directory', async () => {
    await fs.writeFile(path.join(store, 'work.md'), '# work');
    await fs.symlink(store, path.join(root, 'linked'));

    const found = await findMarkdownFiles(root);

    expect(found).toEqual([path.join(root, 'linked', 'work.md')]);
  });

  it('skips broken symlinks without throwing', async () => {
    await fs.writeFile(path.join(root, 'real.md'), 'real');
    await fs.symlink(path.join(store, 'gone.md'), path.join(root, 'dangling.md'));

    const found = await findMarkdownFiles(root);

    expect(found).toEqual([path.join(root, 'real.md')]);
  });

  it('terminates on a self-referential directory symlink', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'a');
    await fs.symlink(root, path.join(root, 'loop'));

    const found = await findMarkdownFiles(root);

    expect(found).toEqual([path.join(root, 'a.md')]);
  });

  it('returns an empty list for a missing directory', async () => {
    const found = await findMarkdownFiles(path.join(root, 'does-not-exist'));

    expect(found).toEqual([]);
  });

  describe('stopAtSkillFile', () => {
    const write = async (relative: string, content = '# doc') => {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), content);
    };

    it('returns only SKILL.md from a skill folder and does not walk below it', async () => {
      await write('brag/SKILL.md');
      await write('brag/README.md');
      await write('brag/slim.md');
      await write('brag/references/step-1-inspect.md');
      await write('brag/scripts/nested/deep/notes.md');

      const found = await findMarkdownFiles(root, undefined, { stopAtSkillFile: true });

      expect(found).toEqual([path.join(root, 'brag', 'SKILL.md')]);
    });

    it('still finds loose commands and skills nested under a plain grouping folder', async () => {
      await write('legacy.md');
      await write('frontend/component.md');
      await write('synced/bucket/pdf/SKILL.md');
      await write('synced/bucket/pdf/reference.md');

      const found = await findMarkdownFiles(root, undefined, { stopAtSkillFile: true });

      expect(found.sort()).toEqual(
        [
          path.join(root, 'legacy.md'),
          path.join(root, 'frontend', 'component.md'),
          path.join(root, 'synced', 'bucket', 'pdf', 'SKILL.md'),
        ].sort()
      );
    });

    it('does not treat the scanned root as a skill folder', async () => {
      await write('SKILL.md');
      await write('other.md');

      const found = await findMarkdownFiles(root, undefined, { stopAtSkillFile: true });

      expect(found.sort()).toEqual([path.join(root, 'SKILL.md'), path.join(root, 'other.md')].sort());
    });

    it('recognises a lowercase skill.md', async () => {
      await write('ship/skill.md');
      await write('ship/guide.md');

      const found = await findMarkdownFiles(root, undefined, { stopAtSkillFile: true });

      expect(found).toEqual([path.join(root, 'ship', 'skill.md')]);
    });

    it('yields nothing from a skill folder whose SKILL.md escapes the containment root', async () => {
      await fs.writeFile(path.join(store, 'SKILL.md'), '# evil');
      await write('evil/README.md');
      await fs.symlink(path.join(store, 'SKILL.md'), path.join(root, 'evil', 'SKILL.md'));

      const found = await findMarkdownFiles(root, root, { stopAtSkillFile: true });

      expect(found).toEqual([]);
    });

    it('keeps a folder with a broken SKILL.md link from leaking its supporting docs', async () => {
      await write('ship/references/guide.md');
      await fs.symlink(path.join(store, 'gone.md'), path.join(root, 'ship', 'SKILL.md'));

      const found = await findMarkdownFiles(root, undefined, { stopAtSkillFile: true });

      expect(found).toEqual([]);
    });

    it('lists every .md when the option is off', async () => {
      await write('brag/SKILL.md');
      await write('brag/references/tones.md');

      const found = await findMarkdownFiles(root);

      expect(found.sort()).toEqual(
        [path.join(root, 'brag', 'SKILL.md'), path.join(root, 'brag', 'references', 'tones.md')].sort()
      );
    });
  });

  // A hostile clone's project skills/commands/agents dir must not follow a
  // symlink out of the checkout; global dirs (no containment root) still may.
  describe('containmentRoot', () => {
    it('skips a symlink whose target escapes the containment root', async () => {
      const target = path.join(store, 'evil.md'); // outside `root`
      await fs.writeFile(target, '# evil');
      await fs.writeFile(path.join(root, 'ok.md'), '# ok');
      await fs.symlink(target, path.join(root, 'escape.md'));

      const found = await findMarkdownFiles(root, root);

      expect(found).toEqual([path.join(root, 'ok.md')]);
    });

    it('follows a symlink whose target stays inside the containment root', async () => {
      await fs.mkdir(path.join(root, 'sub'));
      await fs.writeFile(path.join(root, 'sub', 'real.md'), '# real');
      await fs.symlink(path.join(root, 'sub', 'real.md'), path.join(root, 'link.md'));

      const found = await findMarkdownFiles(root, root);

      expect(found.sort()).toEqual([path.join(root, 'link.md'), path.join(root, 'sub', 'real.md')].sort());
    });

    it('still follows an out-of-tree symlink when no containment root is set', async () => {
      const target = path.join(store, 'SKILL.md');
      await fs.writeFile(target, '# skill');
      await fs.symlink(target, path.join(root, 'SKILL.md'));

      const found = await findMarkdownFiles(root); // global behavior - unconstrained

      expect(found).toEqual([path.join(root, 'SKILL.md')]);
    });
  });
});

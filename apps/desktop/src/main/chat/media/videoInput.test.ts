import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PathAccessDenied } from '../tools/paths';
import type { ToolContext } from '../tools/types';
import { MediaStore } from './MediaStore';
import { resolveInputImage } from './videoInput';

describe('video input secret protection', () => {
  let root: string;
  let context: ToolContext;
  let store: MediaStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-video-input-')));
    const home = await realpath(homedir());
    context = { roots: [root, home], signal: new AbortController().signal };
    store = new MediaStore(join(root, 'media'));
    await mkdir(join(home, '.claude'), { recursive: true });
  });

  it.each(['.claude/settings.json', '.claude/.credentials.json', '.claude.json.backup'])(
    'refuses an image alias of %s before upload',
    async relative => {
      const secret = join(homedir(), relative);
      await writeFile(secret, 'SECRET', 'utf8');
      const alias = join(root, 'frame.png');
      await symlink(secret, alias);
      await expect(resolveInputImage(undefined, alias, context, store)).rejects.toBeInstanceOf(PathAccessDenied);
    }
  );

  it('accepts an ordinary image inside the Claude skills folder', async () => {
    const image = join(homedir(), '.claude', 'skills', 'example', 'frame.png');
    await mkdir(join(image, '..'), { recursive: true });
    await writeFile(image, 'image', 'utf8');
    await expect(resolveInputImage(undefined, image, context, store)).resolves.toMatchObject({
      kind: 'file',
      mimeType: 'image/png',
      size: 5,
    });
  });
});

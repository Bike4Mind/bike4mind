import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalImageResolver } from './LocalImageResolver';
import { MediaStore } from './MediaStore';

const SESSION = 'session-one';
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('valid')]);

describe('LocalImageResolver', () => {
  let base: string;
  let root: string;
  let outside: string;
  let media: MediaStore;
  let resolver: LocalImageResolver;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'b4m-local-image-'));
    root = join(base, 'shared');
    outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    media = new MediaStore(join(base, 'media'));
    resolver = new LocalImageResolver({
      media,
      rootsForSession: async id => (id === SESSION ? [root] : null),
      decode: () => true,
    });
  });

  afterEach(() => rm(base, { recursive: true, force: true }));

  it('imports an approved absolute PNG and serves the copy after the source disappears', async () => {
    const path = join(root, 'workspace-tooltip-opaque.png');
    await writeFile(path, PNG);
    const first = await resolver.resolve(SESSION, path);
    expect(first).toMatchObject({ ok: true, mimeType: 'image/png' });
    await rm(path);
    expect(await resolver.resolve(SESSION, path)).toEqual(first);
  });

  it('canonicalizes the macOS tmp alias when authorizing a path', async () => {
    const aliasBase = await mkdtemp('/tmp/b4m-local-image-alias-');
    try {
      const canonicalRoot = join(await realpath(aliasBase), 'shared');
      const aliasPath = join(aliasBase, 'shared', 'shot.png');
      await mkdir(canonicalRoot);
      await writeFile(aliasPath, PNG);
      const aliased = new LocalImageResolver({
        media,
        rootsForSession: async () => [canonicalRoot],
        decode: () => true,
      });
      expect(await aliased.resolve(SESSION, aliasPath)).toMatchObject({ ok: true });
    } finally {
      await rm(aliasBase, { recursive: true, force: true });
    }
  });

  it.each([
    ['a relative path', () => 'shot.png'],
    ['a file URL', () => 'file:///tmp/shot.png'],
    ['explicit traversal', () => `${root}/../outside/shot.png`],
  ])('refuses %s', async (_label, requested) => {
    await writeFile(join(outside, 'shot.png'), PNG);
    expect(await resolver.resolve(SESSION, requested())).toEqual({ ok: false, error: 'unavailable' });
  });

  it('refuses an unshared path and a symlink escape', async () => {
    const target = join(outside, 'shot.png');
    await writeFile(target, PNG);
    expect(await resolver.resolve(SESSION, target)).toMatchObject({ ok: false });
    const link = join(root, 'linked.png');
    await symlink(target, link);
    expect(await resolver.resolve(SESSION, link)).toMatchObject({ ok: false });
  });

  it('refuses protected paths even beneath a shared root', async () => {
    const protectedPath = join(root, 'vault');
    await mkdir(protectedPath);
    await writeFile(join(protectedPath, 'shot.png'), PNG);
    const guarded = new LocalImageResolver({
      media,
      rootsForSession: async () => [root],
      protectedPaths: [protectedPath],
      decode: () => true,
    });
    expect(await guarded.resolve(SESSION, join(protectedPath, 'shot.png'))).toMatchObject({ ok: false });
  });

  it('refuses an existing sandbox secret path even when its parent is shared', async () => {
    const secret = join(homedir(), '.ssh', `local-image-${Date.now()}.png`);
    await mkdir(join(homedir(), '.ssh'), { recursive: true });
    await writeFile(secret, PNG);
    try {
      const guarded = new LocalImageResolver({ media, rootsForSession: async () => [homedir()], decode: () => true });
      expect(await guarded.resolve(SESSION, secret)).toMatchObject({ ok: false });
    } finally {
      await rm(secret, { force: true });
    }
  });

  it('refuses missing, non-regular, unsupported, mismatched, malformed and oversized inputs', async () => {
    expect(await resolver.resolve(SESSION, join(root, 'missing.png'))).toMatchObject({ ok: false });
    await mkdir(join(root, 'folder.png'));
    expect(await resolver.resolve(SESSION, join(root, 'folder.png'))).toMatchObject({ ok: false });
    await writeFile(join(root, 'text.txt'), 'hello');
    expect(await resolver.resolve(SESSION, join(root, 'text.txt'))).toMatchObject({ ok: false });
    await writeFile(join(root, 'wrong.jpg'), PNG);
    expect(await resolver.resolve(SESSION, join(root, 'wrong.jpg'))).toMatchObject({ ok: false });
    await writeFile(join(root, 'bad.png'), Buffer.from('not an image'));
    expect(await resolver.resolve(SESSION, join(root, 'bad.png'))).toMatchObject({ ok: false });
    await writeFile(join(root, 'huge.png'), Buffer.alloc(24 * 1024 * 1024 + 1));
    expect(await resolver.resolve(SESSION, join(root, 'huge.png'))).toMatchObject({ ok: false });
  });

  it('refuses bytes the image decoder rejects', async () => {
    const path = join(root, 'shot.png');
    await writeFile(path, PNG);
    const invalid = new LocalImageResolver({ media, rootsForSession: async () => [root], decode: () => false });
    expect(await invalid.resolve(SESSION, path)).toMatchObject({ ok: false });
  });
});

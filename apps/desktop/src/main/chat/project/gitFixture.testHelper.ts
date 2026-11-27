import { cp, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Builds a git fixture once per test file and hands each test its own copy, which saves every
 * test the git processes that built it. A copy's index no longer matches its files' inodes, so
 * git re-reads them on the first status; nothing it reports changes.
 */
export function gitFixture(
  prefix: string,
  build: (root: string) => Promise<void>,
  /** The files, relative to the root, where git wrote the fixture's absolute path. */
  pathFiles: readonly string[]
): () => Promise<string> {
  let template: Promise<string> | undefined;
  return async () => {
    template ??= (async () => {
      const root = await freshRoot(`${prefix}template-`);
      await build(root);
      return root;
    })();
    const from = await template;
    const root = await freshRoot(prefix);
    await cp(from, root, { recursive: true, preserveTimestamps: true });
    await Promise.all(
      pathFiles.map(async file => {
        const path = join(root, file);
        await writeFile(path, (await readFile(path, 'utf8')).replaceAll(from, root), 'utf8');
      })
    );
    return root;
  };
}

// realpath because on macOS tmpdir() is a symlink into /private and git reports resolved paths.
const freshRoot = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)));

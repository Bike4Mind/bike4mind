import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Language, Parser, type Tree } from 'web-tree-sitter';

/**
 * Where a wasm asset lives. The build copies both into `wasm/` beside the main bundle; from a
 * source checkout (dev server, vitest) that directory does not exist, so the packages they come
 * from are resolved instead.
 */
function wasmPath(file: string, fallback: string): string {
  const bundled = join(__dirname, 'wasm', file);
  if (existsSync(bundled)) return bundled;
  return createRequire(join(__dirname, 'noop.js')).resolve(fallback);
}

let parser: Promise<Parser> | undefined;

async function createParser(): Promise<Parser> {
  const runtime = wasmPath('tree-sitter.wasm', 'web-tree-sitter/tree-sitter.wasm');
  await Parser.init({ locateFile: () => runtime });
  const bash = await Language.load(
    new Uint8Array(await readFile(wasmPath('tree-sitter-bash.wasm', 'tree-sitter-bash/tree-sitter-bash.wasm')))
  );
  const created = new Parser();
  created.setLanguage(bash);
  return created;
}

/**
 * The syntax tree of a bash script, or null when it does not parse cleanly. The caller owns the
 * tree and must `delete()` it: it lives in wasm memory, outside the garbage collector.
 */
export async function parseBash(command: string): Promise<Tree | null> {
  // A failed start is not cached, so one bad read does not disable the parser for the session.
  parser ??= createParser().catch(err => {
    parser = undefined;
    throw err;
  });
  const tree = (await parser).parse(command);
  if (!tree) return null;
  if (tree.rootNode.hasError) {
    tree.delete();
    return null;
  }
  return tree;
}

#!/usr/bin/env tsx
/**
 * Rewrites every module specifier that points at a file just moved from apps/client/server into
 * packages/server-utils/src.
 *
 * Usage (after `git mv`-ing the files, colocated tests included, to the same tail under src/):
 *   pnpm tsx scripts/codemods/move-to-server-utils.ts apps/client/server/memory/factCipher.ts ...
 *
 * Arguments are the files' OLD paths. Every .ts/.tsx/.mts/.cts/.js/.mjs file under apps/client,
 * apps/workers and packages/server-utils is scanned, and a specifier that resolves (through the
 * @server/, @client/ or @/ alias, or a relative path) to a moved file becomes
 * `@bike4mind/server-utils/<tail>` - or a relative path when the importer is inside the package.
 *
 * Covers static, type-only, side-effect and `export ... from` imports, `import()` (including
 * `typeof import()`), `require()`, and the vi.mock/doMock/unmock/importActual/importMock string
 * argument, multi-line or behind a generic. Idempotent: a second run changes nothing.
 *
 * A moved file that still imports a file left behind in apps/ makes the run throw: the package
 * must stay below both apps (eslint.config.mjs enforces the same boundary).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CLIENT_SERVER = 'apps/client/server';
export const PACKAGE_SRC = 'packages/server-utils/src';
export const PACKAGE_NAME = '@bike4mind/server-utils';

const SCAN_ROOTS = ['apps/client', 'apps/workers', 'packages/server-utils'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', 'premium-generated', 'coverage']);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs)$/;
const STRIP_EXT = /\.(ts|tsx|js|mjs)$/;

// The string argument of every specifier position. Group 1 is everything up to the opening quote,
// group 2 the quote, group 3 the specifier. A vi.* call behind a generic is matched from its `>(`
// via a lookbehind, so the generic itself is not consumed and a `typeof import('x')` inside it is
// still matched on its own (`vi.importActual<typeof import('x')>(\n  'x'\n)`).
const VI_CALL = String.raw`\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*`;
const SPECIFIER = new RegExp(
  String.raw`(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|${VI_CALL}\(\s*|(?<=${VI_CALL}<[^;]*)>\s*\(\s*)(['"])([^'"\n]+)\2`,
  'g'
);

export interface Move {
  /** Repo-relative path without extension, e.g. apps/client/server/memory/factCipher */
  from: string;
  /** Repo-relative path without extension, e.g. packages/server-utils/src/memory/factCipher */
  to: string;
}

export function toMove(oldPath: string): Move {
  const normalized = path.posix.normalize(oldPath.split(path.sep).join('/'));
  if (!normalized.startsWith(`${CLIENT_SERVER}/`) || !SOURCE_EXT.test(normalized)) {
    throw new Error(`Not a source file under ${CLIENT_SERVER}/: ${oldPath}`);
  }
  const from = normalized.replace(STRIP_EXT, '');
  return { from, to: `${PACKAGE_SRC}/${from.slice(CLIENT_SERVER.length + 1)}` };
}

/** Repo-relative, extensionless path a specifier points at, or null for a bare package name. */
export function resolveSpecifier(specifier: string, importerDir: string): string | null {
  let target: string;
  if (specifier.startsWith('@server/')) target = `${CLIENT_SERVER}/${specifier.slice('@server/'.length)}`;
  else if (specifier.startsWith('@client/')) target = `apps/client/${specifier.slice('@client/'.length)}`;
  else if (specifier.startsWith('@/')) target = `apps/client/${specifier.slice(2)}`;
  else if (specifier.startsWith('./') || specifier.startsWith('../')) target = path.posix.join(importerDir, specifier);
  else return null;
  return path.posix.normalize(target).replace(STRIP_EXT, '');
}

function relativeSpecifier(fromDir: string, to: string): string {
  const rel = path.posix.relative(fromDir, to);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Rewrites one file's specifiers. `file` is the importer's repo-relative path as it is now (after
 * the move). Returns the new text, which is `source` itself when nothing changed.
 */
export function rewriteSource(source: string, file: string, moves: Move[]): string {
  const byFrom = new Map(moves.map(m => [m.from, m]));
  const fileNoExt = file.replace(STRIP_EXT, '');
  const movedSelf = moves.find(m => m.to === fileNoExt);
  // A file moved in this run still holds the specifiers it had at its old location, so relative
  // and alias specifiers are resolved from there.
  const resolveFromDir = path.posix.dirname(movedSelf ? movedSelf.from : fileNoExt);
  const insidePackage = file.startsWith('packages/server-utils/');

  return source.replace(SPECIFIER, (whole, lead: string, quote: string, specifier: string) => {
    const target = resolveSpecifier(specifier, resolveFromDir);
    if (target === null) return whole;
    const move = byFrom.get(target) ?? byFrom.get(`${target}/index`);
    if (!move) {
      if (movedSelf && target.startsWith('apps/')) {
        throw new Error(
          `${file} imports '${specifier}', which stays in ${target}. Move that file too, or keep ` +
            `this one in apps/client: ${PACKAGE_NAME} must not import from the apps.`
        );
      }
      return whole;
    }
    const next = insidePackage
      ? relativeSpecifier(path.posix.dirname(fileNoExt), move.to)
      : `${PACKAGE_NAME}/${move.to.slice(PACKAGE_SRC.length + 1)}`;
    return `${lead}${quote}${next}${quote}`;
  });
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield path.join(dir, entry.name);
    }
  }
}

/** Runs the codemod from `root` (the repo root). Returns the repo-relative paths it rewrote. */
export function run(root: string, oldPaths: string[]): string[] {
  const moves = oldPaths.map(toMove);
  moves.forEach((move, i) => {
    const moved = `${move.to}${path.extname(oldPaths[i])}`;
    if (!existsSync(path.join(root, moved))) {
      throw new Error(`${moved} does not exist - git mv the file there before running this.`);
    }
  });

  const changed: string[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    if (!existsSync(abs)) continue;
    for (const absFile of walk(abs)) {
      const file = path.relative(root, absFile).split(path.sep).join('/');
      const source = readFileSync(absFile, 'utf8');
      const next = rewriteSource(source, file, moves);
      if (next !== source) {
        writeFileSync(absFile, next);
        changed.push(file);
      }
    }
  }
  return changed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: pnpm tsx scripts/codemods/move-to-server-utils.ts <old apps/client/server path>...');
    process.exit(1);
  }
  const changed = run(process.cwd(), args);
  console.log(`Rewrote ${changed.length} file(s)`);
  for (const file of changed) console.log(`  ${file}`);
}

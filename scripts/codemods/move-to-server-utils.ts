#!/usr/bin/env tsx
/**
 * Rewrites every module specifier that points at a file just moved from apps/client/server into
 * packages/server-utils/src.
 *
 * Usage (after `git mv`-ing the files, colocated tests included, to the same tail under src/):
 *   pnpm tsx scripts/codemods/move-to-server-utils.ts apps/client/server/memory/factCipher.ts ...
 *
 * Arguments are the files' OLD paths, and only .ts files can be moved: the package's exports map
 * resolves `./src/*.ts`. Every .ts/.tsx/.mts/.cts/.js/.mjs file (not .d.ts) under apps/client,
 * apps/workers, packages, b4m-core and infra is parsed with the TypeScript compiler API. A
 * specifier that resolves (through the @server/, @client/, @/, @pages/, @public/ or @workers/
 * alias, a relative path, or an `@bike4mind/server-utils/<tail>` self-reference) to a moved file
 * becomes `@bike4mind/server-utils/<tail>` - or a relative path when the importer is inside the
 * package.
 *
 * Specifier positions covered: import/export declarations (type-only, side-effect, `export ...
 * from`), `import x = require()`, `import()` types (`typeof import()`), dynamic `import()`,
 * `require()`, `require.resolve()` and the string argument of vi.* / jest.* mock, doMock, unmock,
 * doUnmock, importActual, importMock and requireActual/requireMock calls. Comments and ordinary
 * strings are never touched. A template literal with substitutions cannot be resolved: it is left
 * alone and reported as a warning when its static head points into a moved directory.
 *
 * packages/premium/* are separate private overlay checkouts: they are scanned read-only and every
 * specifier that would change is reported as a warning instead of being rewritten.
 *
 * A moved file that still imports a file left behind in apps/ makes the run throw: the package
 * must stay below both apps (eslint.config.mjs enforces the same boundary). Idempotent: a second
 * run changes nothing.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const CLIENT_SERVER = 'apps/client/server';
export const PACKAGE_SRC = 'packages/server-utils/src';
export const PACKAGE_NAME = '@bike4mind/server-utils';

const SCAN_ROOTS = ['apps/client', 'apps/workers', 'packages', 'b4m-core', 'infra'];
const OVERLAY_DIR = 'packages/premium/';
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', 'premium-generated', 'coverage']);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs)$/;
const STRIP_EXT = /\.(ts|tsx|mts|cts|js|mjs)$/;
const MOCK_METHODS = new Set([
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
  'requireActual',
  'requireMock',
]);

interface Literal {
  /** Offsets of the specifier text, excluding the surrounding quotes. */
  start: number;
  end: number;
  text: string;
}

interface Scan {
  literals: Literal[];
  /** Static heads of template literals with substitutions used as a module specifier. */
  dynamicHeads: string[];
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.(js|mjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isModuleCall(callee: ts.Expression): boolean {
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === 'require';
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const object = callee.expression.text;
    if (object === 'require') return callee.name.text === 'resolve';
    if (object === 'vi' || object === 'jest') return MOCK_METHODS.has(callee.name.text);
  }
  return false;
}

function scanSpecifiers(source: string, file: string): Scan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const literals: Literal[] = [];
  const dynamicHeads: string[] = [];
  const add = (node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral) =>
    literals.push({ start: node.getStart(sf) + 1, end: node.getEnd() - 1, text: node.text });

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal);
    } else if (ts.isCallExpression(node) && isModuleCall(node.expression)) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) add(arg);
      else if (arg && ts.isTemplateExpression(arg)) dynamicHeads.push(arg.head.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { literals, dynamicHeads };
}

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
  if (!normalized.endsWith('.ts') || normalized.endsWith('.d.ts')) {
    throw new Error(`Only .ts files can be moved (the package exports map resolves ./src/*.ts): ${oldPath}`);
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
  else if (specifier.startsWith('@pages/')) target = `apps/client/pages/${specifier.slice('@pages/'.length)}`;
  else if (specifier.startsWith('@public/')) target = `apps/client/public/${specifier.slice('@public/'.length)}`;
  else if (specifier.startsWith('@workers/')) target = `apps/workers/src/${specifier.slice('@workers/'.length)}`;
  else if (specifier.startsWith(`${PACKAGE_NAME}/`))
    target = `${PACKAGE_SRC}/${specifier.slice(PACKAGE_NAME.length + 1)}`;
  else if (specifier.startsWith('./') || specifier.startsWith('../')) target = path.posix.join(importerDir, specifier);
  else return null;
  return path.posix.normalize(target).replace(STRIP_EXT, '');
}

function relativeSpecifier(fromDir: string, to: string): string {
  const rel = path.posix.relative(fromDir, to);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

interface Edit {
  start: number;
  end: number;
  specifier: string;
  next: string;
}

/**
 * Finds the specifier edits for one file without applying them. `file` is the importer's
 * repo-relative path as it is now (after the move). Throws when a moved file imports something
 * left in apps/.
 */
export function findRewrites(source: string, file: string, moves: Move[]): { edits: Edit[]; warnings: string[] } {
  const byFrom = new Map(moves.map(m => [m.from, m]));
  const fileNoExt = file.replace(STRIP_EXT, '');
  const movedSelf = moves.find(m => m.to === fileNoExt);
  // A file moved in this run still holds the specifiers it had at its old location, so relative
  // and alias specifiers are resolved from there. The relative output uses its new directory.
  const resolveFromDir = path.posix.dirname(movedSelf ? movedSelf.from : fileNoExt);
  const insidePackage = file.startsWith('packages/server-utils/');
  const { literals, dynamicHeads } = scanSpecifiers(source, file);

  const edits: Edit[] = [];
  for (const { start, end, text: specifier } of literals) {
    const target = resolveSpecifier(specifier, resolveFromDir);
    if (target === null) continue;

    if (target.startsWith(`${PACKAGE_SRC}/`) && specifier.startsWith(`${PACKAGE_NAME}/`)) {
      if (insidePackage) {
        edits.push({ start, end, specifier, next: relativeSpecifier(path.posix.dirname(fileNoExt), target) });
      }
      continue;
    }

    const move = byFrom.get(target) ?? byFrom.get(`${target}/index`);
    if (!move) {
      if (movedSelf && target.startsWith('apps/')) {
        throw new Error(
          `${file} imports '${specifier}', which stays in ${target}. Move that file too, or keep ` +
            `this one in apps/client: ${PACKAGE_NAME} must not import from the apps.`
        );
      }
      continue;
    }
    const next = insidePackage
      ? relativeSpecifier(path.posix.dirname(fileNoExt), move.to)
      : `${PACKAGE_NAME}/${move.to.slice(PACKAGE_SRC.length + 1)}`;
    edits.push({ start, end, specifier, next });
  }

  const warnings: string[] = [];
  for (const head of dynamicHeads) {
    const target = resolveSpecifier(head, resolveFromDir);
    if (target?.startsWith(`${CLIENT_SERVER}/`) && moves.some(m => m.from.startsWith(target))) {
      warnings.push(`${file}: dynamic specifier starting '${head}' may point at a moved file; update by hand`);
    }
  }
  return { edits, warnings };
}

function applyEdits(source: string, edits: Edit[]): string {
  let out = source;
  for (const { start, end, next } of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + next + out.slice(end);
  }
  return out;
}

/**
 * Rewrites one file's specifiers. Returns the new text, which is `source` itself when nothing
 * changed. Template-literal warnings are appended to `warnings` when given.
 */
export function rewriteSource(source: string, file: string, moves: Move[], warnings: string[] = []): string {
  const found = findRewrites(source, file, moves);
  warnings.push(...found.warnings);
  return applyEdits(source, found.edits);
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

/**
 * Runs the codemod from `root` (the repo root). Returns the repo-relative paths it rewrote and
 * the warnings for things it could not or must not rewrite (overlays, unresolvable templates).
 */
export function run(root: string, oldPaths: string[]): { changed: string[]; warnings: string[] } {
  const moves = oldPaths.map(toMove);
  moves.forEach((move, i) => {
    const moved = `${move.to}${path.extname(oldPaths[i])}`;
    if (!existsSync(path.join(root, moved))) {
      throw new Error(`${moved} does not exist - git mv the file there before running this.`);
    }
  });

  const changed: string[] = [];
  const warnings: string[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    if (!existsSync(abs)) continue;
    for (const absFile of walk(abs)) {
      const file = path.relative(root, absFile).split(path.sep).join('/');
      const source = readFileSync(absFile, 'utf8');
      const found = findRewrites(source, file, moves);
      warnings.push(...found.warnings);
      if (file.startsWith(OVERLAY_DIR)) {
        for (const { specifier } of found.edits) {
          warnings.push(`${file}: '${specifier}' points at a moved file; overlays are separate repos - update by hand`);
        }
        continue;
      }
      const next = applyEdits(source, found.edits);
      if (next !== source) {
        writeFileSync(absFile, next);
        changed.push(file);
      }
    }
  }
  return { changed, warnings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: pnpm tsx scripts/codemods/move-to-server-utils.ts <old apps/client/server path>...');
    process.exit(1);
  }
  const { changed, warnings } = run(process.cwd(), args);
  console.log(`Rewrote ${changed.length} file(s)`);
  for (const file of changed) console.log(`  ${file}`);
  for (const warning of warnings) console.error(`WARNING ${warning}`);
}

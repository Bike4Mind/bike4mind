#!/usr/bin/env node

// Fails when an infra/ `sst.aws.Function` exposes a Function URL (`url:`) but its
// handler is not built on defineLambdaRoute.
//
// A Function URL is a public endpoint: it skips every middleware the Next.js
// transport installs, so the contract has to be wired at the handler. This is the
// scan 4 of scripts/check-contract-gate.sh; the earlier scans cover
// apps/client/pages/api and cannot see a Lambda declared in infra/.
//
// The repo-guards CI job installs nothing, so this is a hand-written scanner
// rather than esbuild/typescript. Known limits: a `defineLambdaRoute(` inside a
// string literal counts as a use (shared with the earlier scans), and the import
// walk proves a routed module is reachable from the handler, not that the exported
// handler delegates to it, so importing any value from a routed module passes.
// Declarations it cannot see: only the literal `new sst.aws.Function(` is found, so an
// alias (`const Fn = sst.aws.Function`), a `$transform(sst.aws.Function, ...)` that sets
// `url`, a spread const mutated after its declaration, and a spread name shadowed by an
// inner `let` all pass unseen. A green gate is not proof none exist.
//
// Usage: node scripts/check-function-url-contracts.mjs <repo-root>
//   stdout: violating handler files, sorted and deduped (empty when clean).
//   exit 0 clean, 1 violations, 2 structural problem (an input this cannot read
//   must not be reported as clean).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

// Re-exported from a premium overlay, so absent from this repo by design.
const OVERLAY_HANDLER_DIR = 'premium-generated/';

// The adapter's own declaration is not a use: a handler that imports only a
// helper such as internalErrorResult from it has no contract.
export const ADAPTER_FILE = 'apps/workers/src/cli/defineLambdaRoute.ts';

// `@workers/*` -> apps/workers/src/* (apps/workers/tsconfig.json). An import that
// resolves through any other alias is left unresolved, which fails closed.
const IMPORT_ALIASES = [['@workers/', 'apps/workers/src/']];

const MAX_IMPORT_DEPTH = 3;

const FUNCTION_PATTERN = /new\s+sst\.aws\.Function\s*\(/g;
const ROUTE_ALIAS_PATTERN = /\bdefineLambdaRoute\s+as\s+([A-Za-z_$][\w$]*)/g;
// Type-only imports erase at build time, so they never pull a module into the bundle.
const TYPE_ONLY_IMPORT_PATTERN = /\b(?:import|export)\s+type\s[^;'"]*?\bfrom\s*(['"])[^'"\n]+\1/g;
const INLINE_TYPE_IMPORT_PATTERN = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*(['"])[^'"\n]+\2/g;

const SPECIFIER_PATTERNS = [
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\bimport\s+(['"])([^'"\n]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

const CLOSERS = { '(': ')', '[': ']', '{': '}' };

// A `/` after one of these characters or words starts a regex literal; after anything else it divides.
const REGEX_PRECEDERS = '(,=:[{;!&|?+-*%~^<>';
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'throw',
  'void',
  'delete',
  'new',
  'yield',
  'await',
]);

/**
 * True when a `/` at $i sits where an expression can start, judged from the
 * preceding code in $text (an array or string, comments already blanked).
 */
function startsRegex(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0 || REGEX_PRECEDERS.includes(text[j])) return true;
  let k = j;
  while (k >= 0 && /[\w$]/.test(text[k])) k--;
  let word = '';
  for (let m = k + 1; m <= j; m++) word += text[m];
  return REGEX_KEYWORDS.has(word);
}

/**
 * Index just past the regex literal that starts at $i, or i + 1 when the line
 * ends first (it was division after all). A closing `/` that runs straight into
 * `/` or `*` is a comment opener, so the start was a misread division (`n++ / 2`,
 * `total! / n`, `</div>`) and is refused.
 */
function regexEnd(text, i) {
  let inClass = false;
  for (let k = i + 1; k < text.length && text[k] !== '\n'; k++) {
    if (text[k] === '\\') k++;
    else if (text[k] === '[') inClass = true;
    else if (text[k] === ']') inClass = false;
    else if (text[k] === '/' && !inClass) return text[k + 1] === '/' || text[k + 1] === '*' ? i + 1 : k + 1;
  }
  return i + 1;
}

/**
 * Replaces comments with spaces (newlines kept) so offset-preserving scans see
 * code only. String, template and regex literals are preserved, since the handler
 * literal has to be read back out; comment markers and quotes inside them are not
 * comments or literal openers. Regex detection is the usual previous-token
 * heuristic, so a `)` or `}` before `/` reads as division (and JSX closing tags
 * can read as a short regex, bounded at end of line).
 */
export function stripComments(source) {
  // Code units, not code points: every offset below is a UTF-16 index.
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };

  // Index just past the string/template literal that starts at $i.
  function stringEnd(i) {
    const quote = source[i];
    const opener = i;
    i++;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
      } else if (quote !== '`' && source[i] === '\n') {
        // Unterminated: a regex literal's stray quote, not a string. Treat the
        // quote as an ordinary character so later comments are still blanked.
        return opener + 1;
      } else if (source[i] === quote) {
        return i + 1;
      } else if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
        // Interpolation is code again, so re-enter the scanner rather than
        // counting braces here: a comment inside it must still be blanked.
        i = scan(i + 2, 1);
      } else {
        i++;
      }
    }
    return quote === '`' ? i : opener + 1; // EOF: same unterminated-quote bound as a newline
  }

  // With `depth` set, stops at the `}` that closes that interpolation; otherwise
  // runs to EOF. Returns the index just past the stop.
  function scan(i, depth) {
    while (i < source.length) {
      const c = source[i];
      if (c === '/' && source[i + 1] === '/') {
        const start = i;
        while (i < source.length && source[i] !== '\n') i++;
        blank(start, i);
      } else if (c === '/' && source[i + 1] === '*') {
        const start = i;
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i = Math.min(i + 2, source.length);
        blank(start, i);
      } else if (c === '/' && startsRegex(out, i)) {
        i = regexEnd(source, i);
      } else if (c === '"' || c === "'" || c === '`') {
        i = stringEnd(i);
      } else if (depth !== undefined && c === '{') {
        depth++;
        i++;
      } else if (depth !== undefined && c === '}' && --depth === 0) {
        return i + 1;
      } else {
        i++;
      }
    }
    return i;
  }

  scan(0, undefined);
  return out.join('');
}

/** Index just past the string/template literal that starts at $i. */
function plainStringEnd(text, i) {
  const quote = text[i];
  const opener = i;
  i++;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
    } else if (quote !== '`' && text[i] === '\n') {
      return opener + 1; // mirrors stringEnd: an unterminated quote is an ordinary character
    } else if (text[i] === quote) {
      return i + 1;
    } else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
      i = plainInterpolationEnd(text, i + 2);
    } else {
      i++;
    }
  }
  return quote === '`' ? i : opener + 1;
}

function plainInterpolationEnd(text, i) {
  let depth = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = plainStringEnd(text, i);
    } else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}' && --depth === 0) {
      return i + 1;
    } else {
      i++;
    }
  }
  return text.length;
}

/** Index just past the bracket opening at $i, skipping bracketed literals. */
function balancedEnd(text, i) {
  const open = text[i];
  const close = CLOSERS[open];
  if (!close) return -1;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = plainStringEnd(text, i);
      continue;
    }
    if (c === '/' && startsRegex(text, i)) {
      i = regexEnd(text, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

/** Splits on top-level commas. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = plainStringEnd(text, i) - 1;
    } else if (c === '/' && startsRegex(text, i)) {
      i = regexEnd(text, i) - 1;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Depth-1 `key: value` pairs of an object literal (bare or quoted keys), or null
 * when it is not one. A `...name` spread of a same-file `const name = {...}` is
 * merged in order; any other spread or a computed key is pushed to $problems,
 * because the `url` could hide in it.
 */
function topLevelProps(literal, fileText, problems, file) {
  const text = literal.trim();
  if (text[0] !== '{') return null;
  const end = balancedEnd(text, 0);
  if (end === -1) return null;
  const props = {};
  for (const part of splitTopLevel(text.slice(1, end - 1))) {
    const body = part.trim();
    const spread = body.match(/^\.\.\.\s*([A-Za-z_$][\w$]*)$/);
    if (spread) {
      // More than one `const NAME` (shadowed or sibling) is ambiguous: the url could be in either.
      const name = spread[1].replace(/\$/g, '\\$');
      const declared = new RegExp(`\\bconst\\s+${name}(?![\\w$])`, 'g');
      const decl =
        [...fileText.matchAll(declared)].length === 1
          ? fileText.match(new RegExp(`${declared.source}\\s*(?::[^;]*?)?=\\s*(?=\\{)`))
          : null;
      const inner = decl && topLevelProps(fileText.slice(decl.index + decl[0].length), fileText, problems, file);
      if (inner) Object.assign(props, inner);
      else problems.push(`${file}: cannot resolve spread '...${spread[1]}' in 'new sst.aws.Function' options`);
      continue;
    }
    if (body.startsWith('...') || body.startsWith('[')) {
      problems.push(`${file}: cannot inspect a spread or computed key in 'new sst.aws.Function' options`);
      continue;
    }
    const match = part.match(/^\s*(?:([A-Za-z_$][\w$]*)|'([^'\n]*)'|"([^"\n]*)")\s*:/);
    if (match) props[match[1] ?? match[2] ?? match[3]] = part.slice(match[0].length).trim();
    else if (body) problems.push(`${file}: cannot inspect '${body}' in 'new sst.aws.Function' options`);
  }
  return props;
}

/** The value of a plain string/template literal, or null when it is computed. */
function stringLiteral(value) {
  const text = value.trim();
  const quote = text[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  if (plainStringEnd(text, 0) !== text.length) return null;
  const body = text.slice(1, -1);
  return quote === '`' && body.includes('${') ? null : body;
}

/**
 * Every `new sst.aws.Function(...)` under $sources whose options literal has a
 * live top-level `url`, plus the declarations this cannot read (its caller must
 * treat those as a failure, not as "no url").
 */
export function findUrlFunctions(sources) {
  const exposed = [];
  const problems = [];

  for (const { file, text } of sources) {
    const clean = stripComments(text);
    for (const match of clean.matchAll(FUNCTION_PATTERN)) {
      const open = match.index + match[0].length - 1;
      const close = balancedEnd(clean, open);
      if (close === -1) {
        problems.push(`${file}: unterminated 'new sst.aws.Function(' call`);
        continue;
      }
      const args = splitTopLevel(clean.slice(open + 1, close - 1));
      const options = args[1];
      if (options === undefined || options.trim() === '') continue;

      const props = topLevelProps(options, clean, problems, file);
      if (!props) {
        problems.push(`${file}: cannot inspect 'new sst.aws.Function' options (expected an object literal)`);
        continue;
      }
      if (!('url' in props) || props.url === 'false' || props.url === 'undefined') continue;
      if (!('handler' in props)) {
        problems.push(`${file}: 'new sst.aws.Function' exposes a Function URL but declares no 'handler'`);
        continue;
      }
      const handler = stringLiteral(props.handler);
      if (handler === null) {
        problems.push(`${file}: 'new sst.aws.Function' exposes a Function URL with a non-literal 'handler'`);
        continue;
      }
      exposed.push({ file, handler });
    }
  }

  return { exposed, problems };
}

/**
 * `path/to/file.exportName` -> the repo-relative source file, or null when
 * nothing matches. `exists` receives repo-relative paths, like
 * usesDefineLambdaRoute's. Mirrors scripts/check-lambda-bundle.mjs, which cannot
 * be imported here: it pulls in esbuild, absent from the no-install repo-guards job.
 */
export function resolveHandlerFile(root, handler, exists = p => fs.existsSync(path.join(root, p))) {
  const dot = handler.lastIndexOf('.');
  if (dot <= 0) return null;
  const base = handler.slice(0, dot);
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function isOverlayHandler(handler) {
  return handler.includes(OVERLAY_HANDLER_DIR);
}

function resolveImport(fromFile, spec, exists) {
  let base;
  if (spec.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  } else {
    const alias = IMPORT_ALIASES.find(([prefix]) => spec.startsWith(prefix));
    if (!alias) return null;
    base = path.posix.normalize(alias[1] + spec.slice(alias[0].length));
  }

  // TS writes `.js` in a specifier that resolves to a `.ts` module.
  const stems = [base];
  const stripped = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  if (stripped !== base) stems.push(stripped);

  for (const stem of stems) {
    for (const candidate of [stem, `${stem}/index`]) {
      for (const ext of SOURCE_EXTENSIONS) {
        if (exists(`${candidate}${ext}`)) return `${candidate}${ext}`;
      }
    }
  }
  return null;
}

// `import { type A, type B } from 'x'` erases like `import type`; a mixed list still pulls the module in.
function dropTypeOnlyImports(text) {
  return text.replace(TYPE_ONLY_IMPORT_PATTERN, '').replace(INLINE_TYPE_IMPORT_PATTERN, (whole, members) => {
    const names = members
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);
    return names.length > 0 && names.every(m => /^type\s/.test(m)) ? '' : whole;
  });
}

function importSpecifiers(text) {
  const specs = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) specs.push(match[2]);
  }
  return specs;
}

/**
 * True when $entryFile, or a local module within MAX_IMPORT_DEPTH imports of it,
 * calls defineLambdaRoute(. Breadth-first, so a shallow use wins.
 */
export function usesDefineLambdaRoute(root, entryFile, io = {}) {
  const read = io.read ?? (file => fs.readFileSync(path.join(root, file), 'utf8'));
  const exists = io.exists ?? (file => fs.existsSync(path.join(root, file)));

  const seen = new Set();
  let frontier = [entryFile];
  for (let depth = 0; depth <= MAX_IMPORT_DEPTH && frontier.length > 0; depth++) {
    const next = [];
    for (const file of frontier) {
      if (!file || seen.has(file)) continue;
      seen.add(file);
      if (file === ADAPTER_FILE) continue;

      let clean;
      try {
        clean = stripComments(read(file));
      } catch {
        continue;
      }

      const names = ['defineLambdaRoute', ...[...clean.matchAll(ROUTE_ALIAS_PATTERN)].map(m => m[1])];
      if (new RegExp(`\\b(?:${names.map(n => n.replace(/\$/g, '\\$')).join('|')})\\s*(?:<[^;]*?>\\s*)?\\(`).test(clean))
        return true;
      for (const spec of importSpecifiers(dropTypeOnlyImports(clean))) {
        const target = resolveImport(file, spec, exists);
        if (target && !seen.has(target)) next.push(target);
      }
    }
    frontier = next;
  }
  return false;
}

function collectSources(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...collectSources(full));
    } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function main() {
  const root = path.resolve(process.argv[2] ?? '.');
  const infraDir = path.join(root, 'infra');
  const fatal = message => {
    console.error(`::error::${message}`);
    console.error('ERROR: The Function URL contract scan could not run; refusing to report a clean result.');
    process.exit(2);
  };

  if (!fs.existsSync(infraDir) || !fs.statSync(infraDir).isDirectory()) {
    fatal(`Infra directory not found at ${path.relative(root, infraDir) || 'infra'}`);
  }

  let sources;
  try {
    sources = collectSources(infraDir).map(abs => ({
      file: path.relative(root, abs).split(path.sep).join('/'),
      text: fs.readFileSync(abs, 'utf8'),
    }));
  } catch (error) {
    fatal(`Could not scan infra/: ${error.message}`);
  }

  const { exposed, problems } = findUrlFunctions(sources);
  const violations = new Set();
  for (const { file, handler } of exposed) {
    if (isOverlayHandler(handler)) continue;
    const handlerFile = resolveHandlerFile(root, handler);
    if (!handlerFile) {
      problems.push(`${file}: no source file for handler '${handler}'`);
    } else if (!usesDefineLambdaRoute(root, handlerFile)) {
      violations.add(handlerFile);
    }
  }

  const sorted = [...violations].sort();
  if (sorted.length > 0) console.log(sorted.join('\n'));

  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    console.error(
      `ERROR: ${problems.length} unreadable Function URL declaration(s) under infra/; the contract gate cannot verify them.`
    );
    process.exit(2);
  }

  process.exit(sorted.length > 0 ? 1 : 0);
}

const invoked = process.argv[1];
if (invoked && fs.realpathSync(invoked) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::Function URL contract scan crashed: ${error.message}`);
    console.error('ERROR: The Function URL contract scan could not run; refusing to report a clean result.');
    process.exit(2);
  }
}

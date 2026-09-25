/**
 * Linear `import ... from '...'` scanning shared by the in-app artifact parser
 * (`@client/app/utils/artifactParser`), the publish-time transpiler
 * (`apps/client/server/services/publish/transpileReactArtifact.ts`) and the sandbox preview
 * (`apps/client/pages/api/react-artifact-sandbox.ts`). All three used to run backtracking regexes
 * over artifact source of unbounded size; the helpers here keep the same match sets without the
 * quadratic rescans and without a clause-length cap. A fourth consumer, codeImportDependencies
 * (the editor's dependency list in ReactArtifactViewer), deliberately matches more: it replaced a
 * single-line regex, so multi-line clauses now count too.
 */

export interface ImportStatement {
  /** Index of the `import` keyword. */
  index: number;
  /** End of the statement: past the optional trailing `\s*;?` when `consumeTrailing` is set. */
  end: number;
  clause: string;
  specifier: string;
}

export interface ImportScanOptions {
  typeKeyword?: boolean;
  consumeTrailing?: boolean;
}

interface Terminator {
  index: number;
  end: number;
  specifier: string;
}

export interface ImportScanner {
  terminatorAt(source: string, at: number): Terminator | null;
  scanImportStatements(source: string, opts?: ImportScanOptions): ImportStatement[];
  replaceImportStatements(
    source: string,
    opts: ImportScanOptions,
    replace: (statement: ImportStatement, text: string) => string
  ): string;
  braceSpan(text: string, greedy?: boolean): { open: number; close: number } | null;
  stripTypeOnlyImports(source: string): string;
  findRelativeImport(source: string): string | null;
  renameAsBindings(clause: string): string;
}

/* eslint-disable no-var -- `var` keeps the serialized body free of anything a compiler might downlevel */
/**
 * Builds the scanner. The sandbox preview ships this function's own source text to the browser
 * (IMPORT_SCANNER_FACTORY_SRC) and calls it there, so the body must stay self-contained - no
 * reference to anything outside it but JS built-ins - and use only syntax no compiler rewrites
 * into a helper call: `var`/`function`, no `??`, `?.`, arrows, spread, default params, template
 * literals or non-ASCII. importStatements.test.ts evaluates the source in an empty context.
 */
export function createImportScanner(): ImportScanner {
  'use strict';
  var WS = /\s/;
  var WORD = /\w/;

  /** `from` at `at` followed by `\s+['"][^'"]+['"]`, or null. The two quotes are independent
   *  character classes in the original regex, so `'x"` terminates a statement - keep it that way. */
  function terminatorAt(source: string, at: number): Terminator | null {
    if (!source.startsWith('from', at)) return null;
    var p = at + 4;
    var wsStart = p;
    while (p < source.length && WS.test(source[p])) p++;
    if (p === wsStart) return null;
    if (source[p] !== "'" && source[p] !== '"') return null;
    var specStart = ++p;
    while (p < source.length && source[p] !== "'" && source[p] !== '"') p++;
    if (p === specStart || p >= source.length) return null;
    return { index: at, end: p + 1, specifier: source.slice(specStart, p) };
  }

  /** Next terminator at or after `from` that a clause can reach: the `\s+` before `from` is what
   *  rules out `}from 'm'` and `nsfrom 'm'`, which the shape below would otherwise pair. */
  function nextTerminator(source: string, from: number): Terminator | null {
    for (var at = source.indexOf('from', from); at !== -1; at = source.indexOf('from', at + 1)) {
      if (at > 0 && WS.test(source[at - 1])) {
        var found = terminatorAt(source, at);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * The single import scan shared by every pass below. It reproduces the match semantics of
   * `/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g` exactly - including the absent word
   * boundary, so an `import` inside an identifier or a string still matches - with no clause-length
   * bound and no super-linear behavior.
   *
   * Pairing rule, which is where the original's backtracking order shows: the greedy `\s+` after
   * `import` is tried at full length first, so a statement takes the earliest valid terminator
   * STRICTLY past that whitespace run, even when a nearer `from` sits at its end. Only when no
   * terminator exists anywhere past the run does the run give a character back, which is why
   * `import  from 'x'` matches with an empty clause and `import from 'x'` does not match at all.
   * That fallback also means a run with no terminator after it ends the whole scan: any later
   * `import` starts past this run, so a terminator for it would have been found here.
   *
   * Both cursors only advance, and the whitespace runs they inspect are disjoint, so the pass is
   * linear in the source length.
   */
  function scanImportStatements(source: string, opts?: ImportScanOptions): ImportStatement[] {
    var typeKeyword = !!(opts && opts.typeKeyword);
    var consumeTrailing = !!(opts && opts.consumeTrailing);
    var found: ImportStatement[] = [];
    var cursor = 0;
    for (;;) {
      var index = source.indexOf('import', cursor);
      if (index === -1) break;
      var head = index + 6;
      var ws = head;
      while (ws < source.length && WS.test(source[ws])) ws++;
      if (ws === head) {
        cursor = index + 1;
        continue;
      }
      if (typeKeyword) {
        if (!source.startsWith('type', ws)) {
          cursor = index + 1;
          continue;
        }
        head = ws + 4;
        ws = head;
        while (ws < source.length && WS.test(source[ws])) ws++;
        if (ws === head) {
          cursor = index + 1;
          continue;
        }
      }
      var term = nextTerminator(source, ws + 1);
      if (!term && ws >= head + 2) term = terminatorAt(source, ws);
      if (!term) break;
      var clauseEnd = term.index;
      while (clauseEnd > ws && WS.test(source[clauseEnd - 1])) clauseEnd--;
      var end = term.end;
      if (consumeTrailing) {
        while (end < source.length && WS.test(source[end])) end++;
        if (source[end] === ';') end++;
      }
      found.push({ index: index, end: end, clause: source.slice(ws, clauseEnd), specifier: term.specifier });
      cursor = end;
    }
    return found;
  }

  function replaceImportStatements(
    source: string,
    opts: ImportScanOptions,
    replace: (statement: ImportStatement, text: string) => string
  ): string {
    var statements = scanImportStatements(source, opts);
    if (!statements.length) return source;
    var out = '';
    var at = 0;
    for (var i = 0; i < statements.length; i++) {
      var statement = statements[i];
      out += source.slice(at, statement.index) + replace(statement, source.slice(statement.index, statement.end));
      at = statement.end;
    }
    return out + source.slice(at);
  }

  /** First `{...}` span, as `/\{([\s\S]*?)\}/` would find it but without its per-brace rescan: if
   *  the first `{` has no `}` after it, no later `{` does either. `greedy` matches `/\{([\s\S]*)\}/`. */
  function braceSpan(text: string, greedy?: boolean): { open: number; close: number } | null {
    var open = text.indexOf('{');
    if (open === -1) return null;
    var close = greedy ? text.lastIndexOf('}') : text.indexOf('}', open + 1);
    return close > open ? { open: open, close: close } : null;
  }

  function trimmed(s: string): string {
    return s.trim();
  }

  function isValueSpecifier(spec: string): boolean {
    return spec !== '' && !/^type\s+(?!as\b)\w/.test(spec);
  }

  /**
   * Remove TypeScript type-only import syntax, which carries no runtime binding. The import
   * rewrites run BEFORE Babel's typescript preset, so they'd otherwise emit broken
   * `const { type Foo } = ...` or gate a type-only package as a missing runtime dep. Idempotent.
   *
   * Handles: whole-clause `import type { X } from 'm'` / `import type X from 'm'` (dropped), and
   * inline `import { type X, y } from 'm'` -> `import { y } from 'm'`. A binding literally named
   * `type` (`import type from 'm'`, `import { type as T } from 'm'`) is preserved - `type` is only
   * a modifier when followed by another binding identifier that is not `as`.
   */
  function stripTypeOnlyImports(source: string): string {
    var withoutTypeStatements = replaceImportStatements(
      source,
      { typeKeyword: true, consumeTrailing: true },
      function () {
        return '';
      }
    );
    return replaceImportStatements(withoutTypeStatements, { consumeTrailing: true }, function (statement, text) {
      var clause = statement.clause;
      var braces = braceSpan(clause);
      if (!braces) return text;
      var kept = clause
        .slice(braces.open + 1, braces.close)
        .split(',')
        .map(trimmed)
        .filter(isValueSpecifier);
      // No value bindings left and no default/namespace before the brace -> whole import was type-only.
      var beforeBrace = clause.slice(0, braces.open).replace(/,\s*$/, '').trim();
      if (!kept.length && !beforeBrace) return '';
      var inText = braceSpan(text);
      return inText ? text.slice(0, inText.open) + '{ ' + kept.join(', ') + ' }' + text.slice(inText.close + 1) : text;
    });
  }

  // Any relative reference (import/export-from, side-effect import, require) points at a sibling
  // file a single-file artifact can't resolve. Same match set, in the same order, as the three
  // regexes this replaced:
  //   /(?:import|export)\b[^;'"]*\bfrom\s*['"](\.\.?\/[^'"]+)['"]/  -> findRelativeImportFrom
  //   /\bimport\s*['"](\.\.?\/[^'"]+)['"]/                          -> RELATIVE_SIDE_EFFECT_IMPORT
  //   /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/                  -> RELATIVE_REQUIRE
  // Only the first was super-linear. The other two stay regexes: a start position can only reach
  // the one quote adjacent to it, so their backtracking runs are disjoint and total work is linear.
  var RELATIVE_SIDE_EFFECT_IMPORT = /\bimport\s*['"](\.\.?\/[^'"]+)['"]/;
  var RELATIVE_REQUIRE = /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/;

  /** `['"](\.\.?\/[^'"]+)['"]` anchored at `quoteAt`: a quote, `./` or `../`, then a non-empty run
   *  to the next quote of EITHER kind - the two quote classes are independent in the patterns
   *  above, so a mismatched pair (`'./x"`) matches and must keep matching. */
  function relativeSpecifierAt(source: string, quoteAt: number): { specifier: string; end: number } | null {
    var quote = source[quoteAt];
    if (quote !== "'" && quote !== '"') return null;
    var p = quoteAt + 1;
    if (source[p] !== '.') return null;
    if (source[++p] === '.') p++;
    if (source[p] !== '/') return null;
    var contentStart = ++p;
    while (p < source.length && source[p] !== "'" && source[p] !== '"') p++;
    if (p === contentStart || p >= source.length) return null;
    return { specifier: source.slice(quoteAt + 1, p), end: p + 1 };
  }

  /** First `;` or quote at or after `from`: where a greedy `[^;'"]*` has to stop. */
  function nextClauseTerminator(source: string, from: number): number {
    for (var p = from; p < source.length; p++) {
      var c = source[p];
      if (c === ';' || c === "'" || c === '"') return p;
    }
    return -1;
  }

  /** The `\bfrom\s*` tail that must sit immediately before the opening quote at `at`, with the
   *  relative specifier it opens. `\s*` can only end where the quote begins, so `from` is at one
   *  fixed offset: the start of the whitespace run before the quote, minus its own length. */
  function relativeFromTail(source: string, at: number): { fromAt: number; specifier: string } | null {
    var spec = relativeSpecifierAt(source, at);
    if (!spec) return null;
    var wsStart = at;
    while (wsStart > 0 && WS.test(source[wsStart - 1])) wsStart--;
    var fromAt = wsStart - 4;
    if (fromAt < 0 || !source.startsWith('from', fromAt)) return null;
    if (fromAt > 0 && WORD.test(source[fromAt - 1])) return null; // the `\b` before `from`
    return { fromAt: fromAt, specifier: spec.specifier };
  }

  /**
   * `/(?:import|export)\b[^;'"]*\bfrom\s*['"](\.\.?\/[^'"]+)['"]/` without its per-keyword rescan of
   * the rest of the file (quadratic). The greedy `[^;'"]*` cannot cross a `;` or a quote and the
   * pattern's own opening quote has to follow `from\s*`, so that first terminator IS the opening
   * quote and `from` sits at one fixed offset before it: one candidate per keyword instead of one
   * per position. Leftmost keyword that completes the shape wins, as in the regex.
   */
  function findRelativeImportFrom(source: string): string | null {
    var importAt = source.indexOf('import');
    var exportAt = source.indexOf('export');
    var terminator = -1;
    var tailFor = -1;
    var tail: { fromAt: number; specifier: string } | null = null;
    while (importAt !== -1 || exportAt !== -1) {
      var at: number;
      if (exportAt === -1 || (importAt !== -1 && importAt < exportAt)) {
        at = importAt;
        importAt = source.indexOf('import', at + 1);
      } else {
        at = exportAt;
        exportAt = source.indexOf('export', at + 1);
      }
      var afterKeyword = at + 6;
      if (WORD.test(source.charAt(afterKeyword))) continue; // the `\b` after import/export
      // Both lookups are monotone in `afterKeyword`, so each one advances at most once per keyword.
      if (terminator < afterKeyword) {
        terminator = nextClauseTerminator(source, afterKeyword);
        if (terminator === -1) return null; // no `;`/quote left: no later keyword can match either
      }
      if (tailFor !== terminator) {
        tailFor = terminator;
        tail = relativeFromTail(source, terminator);
      }
      // `[^;'"]*` starts at the keyword, so a `from` before it belongs to an earlier statement.
      if (tail && tail.fromAt >= afterKeyword) return tail.specifier;
    }
    return null;
  }

  function findRelativeImport(source: string): string | null {
    var importFrom = findRelativeImportFrom(source);
    if (importFrom !== null) return importFrom;
    var sideEffect = source.match(RELATIVE_SIDE_EFFECT_IMPORT);
    if (sideEffect) return sideEffect[1];
    var required = source.match(RELATIVE_REQUIRE);
    return required ? required[1] : null;
  }

  /** `clause.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')` without the regex's rescan of a long word
   *  from every start position. A match can only begin at the start of a word run, since a shorter
   *  `\w+` would be followed by another word char instead of the required `\s`. */
  function renameAsBindings(clause: string): string {
    var out = '';
    var at = 0;
    var n = clause.length;
    while (at < n) {
      if (!WORD.test(clause[at])) {
        out += clause[at++];
        continue;
      }
      var runEnd = at;
      while (runEnd < n && WORD.test(clause[runEnd])) runEnd++;
      var p = runEnd;
      while (p < n && WS.test(clause[p])) p++;
      if (p > runEnd && clause.startsWith('as', p)) {
        p += 2;
        var ws2 = p;
        while (p < n && WS.test(clause[p])) p++;
        var aliasAt = p;
        while (p < n && WORD.test(clause[p])) p++;
        if (ws2 < aliasAt && aliasAt < p) {
          out += clause.slice(at, runEnd) + ': ' + clause.slice(aliasAt, p);
          at = p;
          continue;
        }
      }
      out += clause.slice(at, runEnd);
      at = runEnd;
    }
    return out;
  }

  return {
    terminatorAt: terminatorAt,
    scanImportStatements: scanImportStatements,
    replaceImportStatements: replaceImportStatements,
    braceSpan: braceSpan,
    stripTypeOnlyImports: stripTypeOnlyImports,
    findRelativeImport: findRelativeImport,
    renameAsBindings: renameAsBindings,
  };
}
/* eslint-enable no-var */

/** The factory's source text, for the sandbox preview to evaluate in the browser. */
export const IMPORT_SCANNER_FACTORY_SRC = String(createImportScanner);

const scanner = createImportScanner();
export const scanImportStatements = scanner.scanImportStatements;
export const replaceImportStatements = scanner.replaceImportStatements;
export const braceSpan = scanner.braceSpan;
export const stripTypeOnlyImports = scanner.stripTypeOnlyImports;
/** Exported for unit tests (differential vs the original patterns). */
export const findRelativeImport = scanner.findRelativeImport;
const terminatorAt = scanner.terminatorAt;

const WS = /\s/;

/** The characters `.` excludes in a JS regex. `\s` covers more than these (\u00a0, \ufeff),
 *  so the two classes are not complements of each other. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Is there an `import ... from '<specifier>'` whose clause holds no line break, i.e. a match of
 * `/import\s+.*\s+from\s+['"]<specifier>['"]/`? The `.*` cannot cross a line terminator but the
 * `\s+` runs on either side of it can, so `import Thing\n  from 'react'` still qualifies.
 *
 * At most the two nearest `import`s before a terminator have to be tried: any earlier one's clause
 * would span them, so it is a superset and carries any line terminator they carry.
 * Both the import cursor and the line-terminator cursor only move forward, so the pass is linear.
 */
export function hasSingleLineImportFrom(source: string, specifier: string): boolean {
  let importScan = 0;
  let lastImport = -1;
  let lastClauseStart = -1;
  let prevImport = -1;
  let prevClauseStart = -1;
  let ltScan = 0;
  let lastLineTerminator = -1;
  for (let at = source.indexOf('from'); at !== -1; at = source.indexOf('from', at + 1)) {
    if (at === 0 || !WS.test(source[at - 1])) continue;
    const term = terminatorAt(source, at);
    if (!term || term.specifier !== specifier) continue;

    let wsStart = at;
    while (wsStart > 0 && WS.test(source[wsStart - 1])) wsStart--;

    for (;;) {
      const next = source.indexOf('import', importScan);
      if (next === -1) {
        importScan = source.length;
        break;
      }
      if (next >= wsStart) {
        importScan = next;
        break;
      }
      if (WS.test(source[next + 6])) {
        prevImport = lastImport;
        prevClauseStart = lastClauseStart;
        lastImport = next;
        lastClauseStart = next + 6;
        while (WS.test(source[lastClauseStart])) lastClauseStart++;
      }
      importScan = next + 6;
    }
    if (lastImport === -1) continue;

    let clauseStart = lastClauseStart;
    if (clauseStart >= at) {
      // Nothing but whitespace between the keyword and `from`: the two `\s+` runs still split it
      // over an empty `.*` when there are at least two characters to split, which is why
      // `import  from 'x'` matches and `import from 'x'` does not. With only one character to
      // split, the import before it can still reach this terminator across the keyword.
      if (at - (lastImport + 6) >= 2) return true;
      if (prevImport === -1) continue;
      clauseStart = prevClauseStart;
    }

    while (ltScan < wsStart) {
      if (LINE_TERMINATOR.test(source[ltScan])) lastLineTerminator = ltScan;
      ltScan++;
    }
    if (lastLineTerminator < clauseStart) return true;
  }
  return false;
}

/**
 * External packages the editor's code imports, for the preview's dependency list. Uses the same
 * linear scan the sandbox rewrites with, so a multi-line clause counts too (the single-line regex
 * this replaced skipped it), and runs on every edit without rescanning the rest of the line.
 */
export function codeImportDependencies(code: string): string[] {
  const deps: string[] = [];
  for (const { specifier } of scanImportStatements(code)) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && specifier !== 'react') deps.push(specifier);
  }
  return deps;
}

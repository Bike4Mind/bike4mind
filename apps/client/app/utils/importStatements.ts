/**
 * Linear `import ... from '...'` scanning shared by the in-app artifact parser
 * (`@client/app/utils/artifactParser`) and the publish-time transpiler
 * (`apps/client/server/services/publish/transpileReactArtifact.ts`). Both used to run backtracking
 * regexes over artifact source of unbounded size; the helpers here keep the same match sets
 * without the quadratic rescans and without a clause-length cap.
 */

const WS = /\s/;

export interface ImportStatement {
  /** Index of the `import` keyword. */
  index: number;
  /** End of the statement: past the optional trailing `\s*;?` when `consumeTrailing` is set. */
  end: number;
  clause: string;
  specifier: string;
}

interface Terminator {
  index: number;
  end: number;
  specifier: string;
}

/** `from` at `at` followed by `\s+['"][^'"]+['"]`, or null. The two quotes are independent
 *  character classes in the original regex, so `'x"` terminates a statement - keep it that way. */
function terminatorAt(source: string, at: number): Terminator | null {
  if (!source.startsWith('from', at)) return null;
  let p = at + 4;
  const wsStart = p;
  while (p < source.length && WS.test(source[p])) p++;
  if (p === wsStart) return null;
  if (source[p] !== "'" && source[p] !== '"') return null;
  const specStart = ++p;
  while (p < source.length && source[p] !== "'" && source[p] !== '"') p++;
  if (p === specStart || p >= source.length) return null;
  return { index: at, end: p + 1, specifier: source.slice(specStart, p) };
}

/** Next terminator at or after `from` that a clause can reach: the `\s+` before `from` is what
 *  rules out `}from 'm'` and `nsfrom 'm'`, which the shape below would otherwise pair. */
function nextTerminator(source: string, from: number): Terminator | null {
  for (let at = source.indexOf('from', from); at !== -1; at = source.indexOf('from', at + 1)) {
    if (at > 0 && WS.test(source[at - 1])) {
      const found = terminatorAt(source, at);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The single import scan shared by every pass below. It reproduces the match semantics of
 * `/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g` exactly - including the absent word boundary,
 * so an `import` inside an identifier or a string still matches - with no clause-length bound and
 * no super-linear behavior.
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
export function scanImportStatements(
  source: string,
  opts: { typeKeyword?: boolean; consumeTrailing?: boolean } = {}
): ImportStatement[] {
  const found: ImportStatement[] = [];
  let cursor = 0;
  for (;;) {
    const index = source.indexOf('import', cursor);
    if (index === -1) break;
    let head = index + 6;
    let ws = head;
    while (ws < source.length && WS.test(source[ws])) ws++;
    if (ws === head) {
      cursor = index + 1;
      continue;
    }
    if (opts.typeKeyword) {
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
    const term = nextTerminator(source, ws + 1) ?? (ws >= head + 2 ? terminatorAt(source, ws) : null);
    if (!term) break;
    let clauseEnd = term.index;
    while (clauseEnd > ws && WS.test(source[clauseEnd - 1])) clauseEnd--;
    let end = term.end;
    if (opts.consumeTrailing) {
      while (end < source.length && WS.test(source[end])) end++;
      if (source[end] === ';') end++;
    }
    found.push({ index, end, clause: source.slice(ws, clauseEnd), specifier: term.specifier });
    cursor = end;
  }
  return found;
}

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

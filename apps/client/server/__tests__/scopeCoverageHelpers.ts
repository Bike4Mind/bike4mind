import { readdirSync } from 'fs';
import path from 'path';

/** Every `.ts`/`.tsx` file under `dir`, skipping `__tests__` directories. */
export function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : tsFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Strips both comment forms so a commented-out `requiredScopes` mention never counts as a real
 * gate. Truncates a `//` inside a string literal too, which is harmless for the scans here.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The scope constant a route declares in its `baseApi({ requiredScopes: <PREFIX>_*_SCOPES })` call,
 * or undefined. Anchored to the call itself so a mention anywhere else in the file (a sibling
 * constant reference, or one living only in a comment) cannot satisfy the gate. `callPattern` lets
 * a caller anchor to a more specific opener than a bare `baseApi(`.
 *
 * Shared by filesApiKeyScopeCoverage.test.ts and projectsAgentsApiKeyScopeCoverage.test.ts.
 */
export function extractRequiredScopesGate(
  source: string,
  prefix: string,
  callPattern: string = 'baseApi\\('
): string | undefined {
  const gate = new RegExp(
    `${callPattern}\\{[^}]*requiredScopes:\\s*(${prefix}_(?:READ|WRITE|READ_OR_WRITE)_SCOPES)\\b[^}]*\\}\\)`
  );
  return stripComments(source).match(gate)?.[1];
}

/**
 * Splits a handler chain into [method, body] pairs - body runs to the next `.method(` or EOF.
 * Only a `.method(` at bracket depth 0 (i.e. chained directly off the `baseApi(...)` call, not
 * nested inside a handler body) opens a new block - tracked by walking the source and counting
 * `([{`/`)]}`. Without this, a route method's OWN body calling something that happens to end in
 * `.delete(`/`.get(` (e.g. `await getFilesStorage().delete(filePath)` inside the real DELETE
 * handler in files/index.ts) is mistaken for a second top-level route method, and the real assert
 * that already covers it gets diluted into a body that doesn't contain it.
 *
 * Shared by filesApiKeyScopeCoverage.test.ts, dataLakeApiKeyScopeCoverage.test.ts and
 * projectsAgentsApiKeyScopeCoverage.test.ts - all scan a baseApi(...) method chain for the same
 * shape of route gate, so a fix to the splitter belongs in one place rather than drifting
 * between copies.
 */
export function methodBlocks(source: string): Array<{ method: string; body: string }> {
  const opener = /\.(get|post|put|patch|delete)(?=[<(])/y;
  const starts: Array<{ method: string; index: number }> = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (depth === 0 && ch === '.') {
      opener.lastIndex = i;
      const match = opener.exec(source);
      if (match && source[skipTypeArguments(source, opener.lastIndex)] === '(') {
        starts.push({ method: match[1], index: i });
      }
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
  }
  return starts.map(({ method, index }, i) => ({
    method,
    body: source.slice(index, starts[i + 1]?.index ?? source.length),
  }));
}

/**
 * Returns the index just past a `<...>` type-argument list starting at `index`, or `index` itself
 * when none starts there. Counts angle depth so nested generics such as
 * `.get<Request<{}, {}, {}, { id: string }>>(` are skipped whole; the `>` of an `=>` in a function
 * type is not a closer, and angle brackets inside quoted spans are ignored.
 */
function skipTypeArguments(source: string, index: number): number {
  if (source[index] !== '<') return index;
  let angleDepth = 0;
  for (let i = index; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuotedSpan(source, i);
      continue;
    }
    if (ch === '<') angleDepth++;
    else if (ch === '>' && source[i - 1] !== '=') angleDepth--;
    if (angleDepth === 0) return i + 1;
  }
  return index;
}

/** Index of the closing quote of the string literal opening at `start` (or the last index if unterminated). */
function skipQuotedSpan(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === quote) return i;
  }
  return source.length - 1;
}

/**
 * The ADMIN API-key gate an admin-scoped route must declare. Matches it wherever it sits in the
 * baseApi options (routes mix in `auth: true`, `rateLimit`, etc.), but pins the array to exactly
 * `[ApiKeyScope.ADMIN]` so a route that swaps in a weaker/other scope is not accepted as "gated".
 * A trailing comma is allowed so a wrapped single-element array still reads as gated.
 *
 * Shared by adminApiKeyScopeCoverage.test.ts (which pins the accepted/rejected shapes) and
 * secretRotationsApiKeyScopeCoverage.test.ts.
 */
export const ADMIN_GATE = /requiredScopes:\s*\[\s*ApiKeyScope\.ADMIN\s*,?\s*\]/;

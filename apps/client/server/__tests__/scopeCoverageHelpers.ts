/**
 * Splits a handler chain into [method, body] pairs - body runs to the next `.method(` or EOF.
 * Only a `.method(` at bracket depth 0 (i.e. chained directly off the `baseApi(...)` call, not
 * nested inside a handler body) opens a new block - tracked by walking the source and counting
 * `([{`/`)]}`. Without this, a route method's OWN body calling something that happens to end in
 * `.delete(`/`.get(` (e.g. `await getFilesStorage().delete(filePath)` inside the real DELETE
 * handler in files/index.ts) is mistaken for a second top-level route method, and the real assert
 * that already covers it gets diluted into a body that doesn't contain it.
 *
 * Shared by filesApiKeyScopeCoverage.test.ts and dataLakeApiKeyScopeCoverage.test.ts - both scan a
 * baseApi(...) method chain for the same shape of route gate, so a fix to the splitter belongs in
 * one place rather than drifting between two copies.
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
 * type is not a closer.
 */
function skipTypeArguments(source: string, index: number): number {
  if (source[index] !== '<') return index;
  let angleDepth = 0;
  for (let i = index; i < source.length; i++) {
    const ch = source[i];
    if (ch === '<') angleDepth++;
    else if (ch === '>' && source[i - 1] !== '=') angleDepth--;
    if (angleDepth === 0) return i + 1;
  }
  return index;
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

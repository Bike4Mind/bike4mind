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
  const opener = /\.(get|post|put|patch|delete)(?:<[^<>]*>)?\(/y;
  const starts: Array<{ method: string; index: number }> = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (depth === 0 && ch === '.') {
      opener.lastIndex = i;
      const match = opener.exec(source);
      if (match) starts.push({ method: match[1], index: i });
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
  }
  return starts.map(({ method, index }, i) => ({
    method,
    body: source.slice(index, starts[i + 1]?.index ?? source.length),
  }));
}

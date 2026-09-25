// Shared by the regex-linearity tests in this package. Mirrors assertLinearGrowth in
// b4m-core/utils/src/artifactParser.test.ts, but returns numbers so this file stays vitest-free
// (it is not excluded from the package build).

export const SMALL_INPUT_MS_CEILING = 500;
export const GROWTH_RATIO_CEILING = 3;
const MIN_BASELINE_MS = 5;

export function measureGrowth(run: (input: string) => unknown, build: (n: number) => string, small: number) {
  const time = (n: number) => {
    const input = build(n);
    const startedAt = performance.now();
    run(input);
    return performance.now() - startedAt;
  };
  const baselineMs = time(small);
  // Skip the doubled run once the baseline has already failed: on a super-linear regex it can take minutes.
  if (baselineMs >= SMALL_INPUT_MS_CEILING) return { baselineMs, ratio: Infinity };
  const doubledMs = time(small * 2);
  return { baselineMs, ratio: doubledMs / Math.max(baselineMs, MIN_BASELINE_MS) };
}

/** Deterministic LCG (Numerical Recipes constants) so CI generates the identical corpus every run. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function seededCorpus(seed: number, count: number, pieces: string[], maxPieces = 12): string[] {
  const rand = lcg(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = 1 + Math.floor(rand() * maxPieces);
    let s = '';
    for (let j = 0; j < len; j++) s += pieces[Math.floor(rand() * pieces.length)];
    out.push(s);
  }
  return out;
}

/** Match position, end, and trimmed captures: what callers that trim their captures can observe. */
export function trimmedMatches(re: RegExp, input: string): Array<{ index: number; end: number; groups: string[] }> {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const global = new RegExp(re.source, flags);
  const all = re.flags.includes('g')
    ? [...input.matchAll(global)]
    : [input.match(re)].filter((m): m is RegExpMatchArray => m !== null);
  return all.map(m => ({
    index: m.index ?? -1,
    end: (m.index ?? 0) + m[0].length,
    groups: m.slice(1).map(g => (g ?? '').trim()),
  }));
}

/** Corpus entries where the two regexes disagree on position, end, or any trimmed capture. */
export function regexDivergences(oldRe: RegExp, newRe: RegExp, corpus: string[]): string[] {
  return corpus.filter(s => JSON.stringify(trimmedMatches(oldRe, s)) !== JSON.stringify(trimmedMatches(newRe, s)));
}

export const FENCE_PIECES = ['```', '```json', '```JSON', 'json', ' ', '\n', '\t', '\r', '{"a":1}', 'x', '`', '\n```'];

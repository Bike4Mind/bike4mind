// Shared by the regex-linearity tests in apps/client. Mirrors assertLinearGrowth in
// b4m-core/utils/src/artifactParser.test.ts, but returns numbers so this file stays vitest-free.

export const SMALL_INPUT_MS_CEILING = 500;
export const GROWTH_RATIO_CEILING = 3;
const MIN_BASELINE_MS = 5;
const SAMPLES = 5;
const CALIBRATED_BASELINE_MS = 25;
const MAX_CALIBRATED_CHARS = 1_000_000;

export function measureGrowth(run: (input: string) => unknown, build: (n: number) => string, small: number) {
  const time = (input: string) => {
    const startedAt = process.threadCpuUsage();
    run(input);
    const { user, system } = process.threadCpuUsage(startedAt);
    return (user + system) / 1000;
  };
  let n = small;
  let baselineInput = build(n);
  // Skip the doubled run once the baseline has already failed: on a super-linear regex it can take minutes.
  const firstMs = time(baselineInput);
  if (firstMs >= SMALL_INPUT_MS_CEILING) return { baselineMs: firstMs, ratio: Infinity };
  // The input doubles until a warm run takes CALIBRATED_BASELINE_MS, so the ratio compares samples well
  // above timer, JIT and GC noise; each size keeps its fastest of SAMPLES runs. Times are thread CPU ms:
  // on a loaded runner a longer run is likelier to be preempted, which inflates a wall-clock ratio.
  while (time(baselineInput) < CALIBRATED_BASELINE_MS && baselineInput.length < MAX_CALIBRATED_CHARS) {
    n *= 2;
    baselineInput = build(n);
    const coldMs = time(baselineInput);
    if (coldMs >= SMALL_INPUT_MS_CEILING) return { baselineMs: coldMs, ratio: Infinity };
  }
  const fastest = (input: string) => Math.min(...Array.from({ length: SAMPLES }, () => time(input)));
  const baselineMs = fastest(baselineInput);
  const doubledMs = fastest(build(n * 2));
  let ratio = doubledMs / Math.max(baselineMs, MIN_BASELINE_MS);
  // A cache or heap-size cliff lands in one doubling step; a quadratic scan is 4x on both.
  if (ratio >= GROWTH_RATIO_CEILING) {
    ratio = Math.min(ratio, fastest(build(n * 4)) / Math.max(doubledMs, MIN_BASELINE_MS));
  }
  return { baselineMs, ratio };
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

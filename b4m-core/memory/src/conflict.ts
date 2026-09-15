/**
 * Telling a RESTATEMENT apart from a DISAGREEMENT, for the de-dup seam.
 *
 * Semantic de-dup coalesces two facts above `MEMENTO_DEDUP_SIMILARITY` onto one subject, and an
 * assert on an existing subject REPLACES that belief (see `foldEvents`). That is exactly right for a
 * restatement and exactly wrong for a disagreement: measured against the live embedding model,
 * "Uptime is 99.9%" and "Uptime is 99.5%" sit at 0.99 cosine, so the second silently destroys the
 * first and the lake keeps only whichever document happened to be extracted last.
 *
 * These helpers are the guard for that. They are deliberately NOT a contradiction detector: deciding
 * whether two dated claims genuinely conflict needs context these short, context-stripped facts no
 * longer carry (measured: a real disagreement can embed LOWER than an unrelated pair, so no
 * similarity threshold separates them). The only question asked here is the narrow, decidable one -
 * do these two state different numbers - and the only consequence is that both are KEPT rather than
 * one being destroyed. Reading them as a conflict is left to the model, which has the context.
 */

/**
 * Numbers as written: optional thousands separators, optional decimal part. Currency symbols and
 * units are outside the match on purpose - "$10" and "10 dollars" both yield `10`, so a comparison
 * is about the figure rather than how it was spelled.
 *
 * Three classes fall outside it, all deliberately: a leading sign (`-5` reads as `5`), non-ASCII
 * digits, and integers past float precision (which collapse onto one another). Each makes the
 * comparison answer "restatement", which is the PRE-EXISTING de-dup behaviour - so the worst case
 * is a disagreement this does not rescue, never one it newly destroys. Widening the pattern to
 * catch them would also start splitting hyphenated dates and ranges into signed figures, which is
 * a real regression traded for a hypothetical one.
 */
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/**
 * The figures a fact states, canonicalized so formatting is not read as disagreement: `99.90` and
 * `99.9` are one figure, `1,200` and `1200` are one figure. A value that will not parse stays
 * literal rather than collapsing to NaN, so version-like strings keep comparing as themselves.
 */
export function factFigures(text: string): Set<string> {
  const figures = new Set<string>();
  for (const raw of text.match(NUMBER) ?? []) {
    const bare = raw.replace(/,/g, '');
    const numeric = Number(bare);
    figures.add(Number.isFinite(numeric) ? String(numeric) : bare);
  }
  return figures;
}

/**
 * Whether two near-duplicate facts state a different set of figures.
 *
 * A fact with no figures at all is never treated as disagreeing - a qualitative restatement should
 * still coalesce, which is what de-dup is for.
 */
export function statesDifferentFigures(a: string, b: string): boolean {
  const figuresA = factFigures(a);
  const figuresB = factFigures(b);
  if (figuresA.size === 0 || figuresB.size === 0) return false;
  if (figuresA.size !== figuresB.size) return true;
  for (const figure of figuresA) if (!figuresB.has(figure)) return true;
  return false;
}

/** Whether two facts came from entirely different source documents. */
export function fromDisjointSources(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const seen = new Set(a);
  return !b.some(source => seen.has(source));
}

/**
 * A subject that keeps a preserved claim from colliding with the one it disagrees with.
 *
 * Necessary because `subjectKey` drops single-character tokens, so "Uptime is 99.9%" and "Uptime is
 * 99.5%" both reduce to `99 uptime` - writing the preserved claim under its own derived subject
 * would hash onto the very belief it was being kept apart from. Appending the figures is
 * deterministic, so re-extracting the same fact from the same document still lands on the same
 * subject and still de-dups across runs.
 */
export function figureScopedSubject(derivedSubject: string, text: string): string {
  const figures = [...factFigures(text)].sort();
  return figures.length === 0 ? derivedSubject : `${derivedSubject} ${figures.join(' ')}`;
}

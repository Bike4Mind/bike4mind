/**
 * How recalled memory is FRAMED for the model - the system text that wraps the facts recall surfaces.
 *
 * This is one of the highest-leverage strings in the product and it lived, wrong, in three different
 * places at once: chat V2 injected each fact as its own `[Memory] <fact>` system message, chat V1 as
 * `[Memory - 87% relevant] <summary>`, and agent mode as a `[KNOWN FACTS ABOUT THE USER]` list with a
 * weak "do not mention this list" aside. All three make the model RECITE - "I recall that you...",
 * "based on what I have on file" - which is the tell that separates a memory feature that feels like a
 * case file from one that feels like a person who remembers you.
 *
 * The wording below is not a guess. It was A/B'd against those three formats on real recalled facts and
 * real questions, judged for transcript-talk (the model announcing its memory) and usefulness:
 *
 *      framing                       transcript-talk   useful/5
 *      per-message [Memory] <fact>         33%           4.61
 *      labeled KNOWN FACTS list            17%           4.56
 *      this one                             0%           4.72   <- best on BOTH axes
 *
 * Two things do the work: the facts are framed as the assistant's OWN standing knowledge rather than
 * retrieved documents, and the instruction is POSITIVE ("the way a friend who remembers would") rather
 * than a negative "do not mention" that models leak past. Change this string and you are shipping an
 * untested variant - re-run memento-eval/scorecard/framing-ab.mjs.
 *
 * ALL memory-injection sites must route through here so the framing cannot drift back into three.
 */
export function buildMemoryContext(facts: readonly string[]): string {
  if (facts.length === 0) return '';
  return (
    `You already know this person from past conversations. Draw on what you know naturally, the way a ` +
    `friend who remembers would - never announce that you are recalling something, never list what you ` +
    `know, never mention memory or context. Just let it inform your answer.\n\n` +
    `What you know about them:\n${facts.map(f => `- ${f}`).join('\n')}`
  );
}

/** Max chars per lake reference fact, so one extracted line cannot dominate the injected block. */
const LAKE_FACT_MAX_CHARS = 500;

/**
 * Sanitize one LAKE fact before it enters a system block. Lake facts are LLM-extracted from UPLOADED
 * documents - in a shared lake, whoever can upload can influence them - so this is a security boundary,
 * not cosmetics: collapse newlines/control chars (a raw newline would let a fact escape its bullet and
 * inject free-form system lines) and bound the length.
 *
 * The `.trim()` runs LAST on purpose, and must stay there: trimming before the clip leaves a fact
 * clipped at exactly LAKE_FACT_MAX_CHARS able to end in a space that a second pass would strip, and
 * `lakeMemoryFacts` counts what this returns while `buildLakeMemoryContext` re-sanitizes to render it.
 */
function sanitizeLakeFact(fact: string): string {
  return fact
    .replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, LAKE_FACT_MAX_CHARS)
    .trim();
}

/**
 * The facts `buildLakeMemoryContext` will actually render: sanitized, with the ones that sanitize to
 * nothing dropped. Exported so a caller that has to REPORT what it injected (retrieval telemetry's
 * `injected.chunks` / `injected.chars`) counts the same facts the render emits, rather than the raw
 * beliefs or the rendered block including its framing. `sanitizeLakeFact` is idempotent, so passing
 * this straight into `buildLakeMemoryContext` is safe and keeps the sanitize unconditional there.
 */
export function lakeMemoryFacts(facts: readonly string[]): string[] {
  return facts.map(sanitizeLakeFact).filter(Boolean);
}

/**
 * A lake fact as the caller holds it: bare text, or text with the date of the document it came from.
 * The union keeps ONE framing function rather than a dated twin that could drift from it.
 */
export type LakeFactInput = string | { fact: string; sourceDate?: string };

const factText = (fact: LakeFactInput): string => (typeof fact === 'string' ? fact : fact.fact);
const factDate = (fact: LakeFactInput): string | undefined => (typeof fact === 'string' ? undefined : fact.sourceDate);

/**
 * Framing for LAKE reference facts (#1440) - a deliberate sibling of `buildMemoryContext`, kept HERE so
 * all memory framing still lives in one auditable place. It differs on purpose: lake facts are reference
 * material extracted from curated documents, NOT things the assistant knows about the person, so they
 * are framed as background knowledge and attribution is NOT suppressed (the model may say a fact came
 * from the knowledge base). Each fact is sanitized + length-bounded first (see sanitizeLakeFact) because
 * the content is untrusted uploaded text.
 *
 * DATES, and why they are an instruction rather than a detector (#1501 item 4). Two documents in one
 * lake can state different figures for the same thing, and the write path now keeps both rather than
 * letting the later extraction destroy the earlier claim. Deciding which of them is actually a
 * contradiction was measured and rejected: over short, context-stripped facts a genuine disagreement
 * can embed LOWER than an unrelated pair ("Price is $10"/"Price is $20" at 0.76 against "Q1 revenue
 * 100M"/"Q2 revenue 150M" at 0.79), so no threshold separates them and any asserted "these conflict"
 * note would be wrong a good share of the time. Dating every fact and asking the model to surface
 * disagreements costs a few tokens, cannot produce a false accusation, and leaves the judgement with
 * the only reader that still has the context to make it.
 *
 * A date is `YYYY-MM-DD`, machine-formatted from the document's own timestamp, so unlike the fact text
 * it is not attacker-influenced. An unknown date is stated rather than omitted: silence would let the
 * model read an undated claim as the older or the newer one, which is exactly the wrong inference on
 * the turn this matters.
 */
export function buildLakeMemoryContext(facts: readonly LakeFactInput[]): string {
  const clean = facts
    .map(fact => ({ text: sanitizeLakeFact(factText(fact)), date: factDate(fact) }))
    .filter(fact => Boolean(fact.text));
  if (clean.length === 0) return '';

  const dated = clean.some(fact => fact.date);
  const preamble =
    `Background reference facts from the user's knowledge base. Use them to ground your answer where ` +
    `relevant; you may attribute or cite them.` +
    (dated
      ? ` Each fact is dated by the document it came from; where two of them disagree, say so and give ` +
        `both with their dates rather than silently choosing one.`
      : '');
  const bullets = clean
    .map(fact => (dated ? `- ${fact.text} (document dated ${fact.date ?? 'unknown'})` : `- ${fact.text}`))
    .join('\n');

  return `${preamble}\n\nReference facts:\n${bullets}`;
}

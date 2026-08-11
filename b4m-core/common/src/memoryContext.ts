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
 */
function sanitizeLakeFact(fact: string): string {
  return fact
    .replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, LAKE_FACT_MAX_CHARS);
}

/**
 * Framing for LAKE reference facts (#1440) - a deliberate sibling of `buildMemoryContext`, kept HERE so
 * all memory framing still lives in one auditable place. It differs on purpose: lake facts are reference
 * material extracted from curated documents, NOT things the assistant knows about the person, so they
 * are framed as background knowledge and attribution is NOT suppressed (the model may say a fact came
 * from the knowledge base). Each fact is sanitized + length-bounded first (see sanitizeLakeFact) because
 * the content is untrusted uploaded text.
 */
export function buildLakeMemoryContext(facts: readonly string[]): string {
  const clean = facts.map(sanitizeLakeFact).filter(Boolean);
  if (clean.length === 0) return '';
  return (
    `Background reference facts from the user's knowledge base. Use them to ground your answer where ` +
    `relevant; you may attribute or cite them.\n\n` +
    `Reference facts:\n${clean.map(f => `- ${f}`).join('\n')}`
  );
}

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

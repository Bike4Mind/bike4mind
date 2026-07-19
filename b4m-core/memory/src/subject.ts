/**
 * Subject resolution - how a free-text fact resolves to a stable `subject` so that re-mentions
 * AFFIRM one belief (heat + provenance accrue, decay resets) instead of piling up as near-duplicates
 * that the fold can never collapse. Without this, real extraction turns the ledger into a landfill.
 *
 * This is the CHEAP, deterministic resolver (option a): a normalized content key. It merges exact
 * restatements and case/punctuation/word-order variants; it does NOT merge paraphrases or
 * inflections ("targets pharma" vs "pursuing pharma clients", "love" vs "loves") - that needs an
 * embedding or LLM resolver. The seam for that upgrade is `resolveSubject`: keep writing the RESOLVED
 * subject into the event (so the fold stays deterministic and replayable) and only swap what
 * computes it. Start cheap, measure merge quality, pay for embeddings later.
 */

import { tokenize } from './text';

/**
 * Deterministic content key for a fact: lowercase tokens, stopwords dropped, de-duplicated and
 * sorted so word order does not matter. Empty when the text has no content tokens (caller should
 * fall back to an explicit subject).
 */
export function subjectKey(text: string): string {
  return [...new Set(tokenize(text))].sort().join(' ');
}

/**
 * Resolve the subject for a new event. An explicit, non-empty subject always wins (the caller knows
 * the identity); otherwise derive it from the fact via `subjectKey`. Returns null when neither
 * yields a usable key, so the caller can reject the event rather than key it on ''.
 */
export function resolveSubject(input: { subject?: string; fact?: string }): string | null {
  const explicit = input.subject?.trim();
  if (explicit) return explicit;
  const derived = input.fact ? subjectKey(input.fact) : '';
  return derived || null;
}

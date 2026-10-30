/** Cap on a release-note headline: the editorial prompt, the post-repair trim and the fallback all enforce it. */
export const MAX_HEADLINE_CHARS = 120;
export const MAX_SUMMARY_CHARS = 600;
// Item cap is enforced on the first editorial attempt only (see writeReleaseNotes), so an over-long item never
// fails a release; an over-long headline or summary is trimmed after the repair for the same reason.
// Input notes have their own cap: MAX_CUSTOMER_NOTE_CHARS in generate.ts and CUSTOMER_NOTE_CHARS in the
// packages/scripts payload builder.
export const MAX_ITEM_CHARS = 160;

/**
 * Cuts `text` to at most `max` chars at the last sentence end past the halfway mark, else the last word
 * boundary, else a hard cut; the word and hard cuts end in `...`. Never splits a surrogate pair.
 */
export function trimToBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
  const sentenceEnd = Math.max(...['. ', '! ', '? '].map(end => head.lastIndexOf(end))) + 1;
  const sentenceEndAtLimit = /[.!?]$/.test(head) && text[head.length] === ' ' ? head.length : 0;
  const sentence = Math.max(sentenceEnd, sentenceEndAtLimit);
  if (sentence > max / 2) return head.slice(0, sentence).trimEnd();
  const short = text.slice(0, max - 3).replace(/[\uD800-\uDBFF]$/, '');
  const word = short.lastIndexOf(' ');
  return `${(word > 0 ? short.slice(0, word) : short).trimEnd()}...`;
}

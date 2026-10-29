/** Cap on a release-note headline: the editorial prompt, the post-repair trim and the fallback all enforce it. */
export const MAX_HEADLINE_CHARS = 120;
export const MAX_SUMMARY_CHARS = 600;
// Item cap is enforced on the first editorial attempt only (see writeReleaseNotes), so an over-long item never
// fails a release; an over-long headline or summary is trimmed after the repair for the same reason.
// Input notes have their own cap: MAX_CUSTOMER_NOTE_CHARS in generate.ts and CUSTOMER_NOTE_CHARS in the
// packages/scripts payload builder.
export const MAX_ITEM_CHARS = 160;

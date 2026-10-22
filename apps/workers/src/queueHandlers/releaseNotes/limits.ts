/** Cap on a release-note headline: the draft schema, the editorial prompt and the fallback all enforce it. */
export const MAX_HEADLINE_CHARS = 120;
export const MAX_SUMMARY_CHARS = 600;
// Enforced on the first editorial attempt only (see writeReleaseNotes), so an over-long item never fails a release.
// Input notes have their own cap: MAX_CUSTOMER_NOTE_CHARS in generate.ts and CUSTOMER_NOTE_CHARS in the
// packages/scripts payload builder.
export const MAX_ITEM_CHARS = 160;

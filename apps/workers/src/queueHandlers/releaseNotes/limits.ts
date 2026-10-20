/** Cap on a release-note headline: the draft schema, the editorial prompt and the fallback all enforce it. */
export const MAX_HEADLINE_CHARS = 120;
// Draft schema and editorial prompt both state these; the payload builder's CUSTOMER_NOTE_CHARS matches the summary.
export const MAX_SUMMARY_CHARS = 600;
export const MAX_ITEM_CHARS = 160;

export const ACQUISITION_FIELD_LIMIT = 128;
/** Unicode lowercasing can expand one stored UTF-16 code unit into two in a cohort key. */
export const ACQUISITION_FOLDED_FIELD_LIMIT = ACQUISITION_FIELD_LIMIT * 2;

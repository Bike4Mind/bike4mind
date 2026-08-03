/**
 * One definition of "the same tag", shared by every path that has to decide whether two tag names
 * collide. Must stay in sync with tagService/listFileTags (which folds unclaimed aggregate buckets
 * onto tag documents) and the chip match in Files/Browser/ItemActions - if the three disagree, a
 * rename can merge two documents the UI still draws as separate, or leave two the UI draws as one.
 */

/**
 * Trim only. Casing is deliberately preserved: tag documents keep whatever casing they were
 * created with, and a rename writes the name as the caller spelled it.
 */
export const normalizeTagName = (raw: string): string => raw.trim();

/**
 * toLowerCase and not toLocaleLowerCase, whose dotless-i mapping varies by runtime locale - the
 * same reasoning listFileTags spells out where it folds bucket names.
 */
export const foldTagName = (raw: string): string => raw.trim().toLowerCase();

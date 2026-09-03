/**
 * Pure slug helpers for the Data Lake wizard, kept dependency-free (no hooks,
 * axios, or store) so the client gate and its tests exercise the same logic the
 * server validates against. Every bound here comes from @bike4mind/common, which
 * CreateDataLakeRequestInput validates against - the wizard and the schema cannot
 * disagree because there is only one copy of each rule.
 */
import { MAX_TAG_PREFIX_LENGTH, MIN_DATA_LAKE_SLUG_LENGTH, MAX_DATA_LAKE_SLUG_LENGTH } from '@bike4mind/common';

/**
 * Slugify a string for use as a data lake slug. Trimming the leading/trailing
 * hyphen AFTER truncating is deliberate: truncation can land mid-word and leave a
 * dangling '-' (e.g. a >60-char name), which DATA_LAKE_SLUG_REGEX (`[a-z0-9]$`) would
 * reject. With that, the output always satisfies the regex, so length is the only gate
 * left (see isValidDataLakeSlug); dataLakeSlug.test pins that against the shared pattern.
 */
export function slugifyDataLakeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_DATA_LAKE_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
}

/** Whether a name slugifies to a server-acceptable slug (>= MIN_DATA_LAKE_SLUG_LENGTH chars). */
export function isValidDataLakeSlug(name: string): boolean {
  return slugifyDataLakeName(name).length >= MIN_DATA_LAKE_SLUG_LENGTH;
}

/**
 * The tag prefix the wizard offers for a lake name: its slug, capped to fit, plus the ":".
 * Empty when the name has no alphanumerics to build one from.
 *
 * The cap is the point. A slug may be 60 chars but a fileTagPrefix only 30, so deriving
 * straight from the slug handed the user a prefix the server refuses - and since nothing
 * client-side bounded it, the create failed at submit instead of in the form.
 *
 * The hyphen trim has to run AFTER this second cut: slugifyDataLakeName only trims once its
 * own 60-slice is done, so slicing again can re-expose a dangling '-' (cosmetic here, since
 * the slug regex governs the slug field rather than the prefix, but "triage-router-dry-run-test-:"
 * is not a prefix anyone wants stamped on every file).
 */
export function deriveTagPrefixFromLakeName(name: string): string {
  const stem = slugifyDataLakeName(name)
    .slice(0, MAX_TAG_PREFIX_LENGTH - 1)
    .replace(/-+$/, '');
  // A name with no alphanumerics slugifies to '' and would derive a bare ':' - a prefix that
  // is all separator and no namespace. There is nothing to offer, so offer nothing (callers
  // treat '' as "not derived" and leave the field to the user).
  if (!stem) return '';
  return `${stem}:`;
}

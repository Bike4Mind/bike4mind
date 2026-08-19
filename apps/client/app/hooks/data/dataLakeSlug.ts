/**
 * Pure slug helpers for the Data Lake wizard, kept dependency-free (no hooks,
 * axios, or store) so the client gate and its tests exercise the same logic the
 * server validates against. Mirrors slug.min(2) + slugRegex in common/schemas/dataLake,
 * and the fileTagPrefix max that bounds the prefix derived from a lake name.
 */
import { MAX_TAG_PREFIX_LENGTH } from '@bike4mind/common';

/**
 * Minimum length the server enforces on a lake slug (see slug.min(2) in
 * common/schemas/dataLake). A name that slugifies shorter than this is rejected
 * server-side, so the wizard gates on it client-side too.
 */
export const MIN_DATA_LAKE_SLUG_LENGTH = 2;

/** Max slug length the server accepts (slug.max(60)); we truncate to it here. */
const MAX_DATA_LAKE_SLUG_LENGTH = 60;

/**
 * Slugify a string for use as a data lake slug. Trimming the leading/trailing
 * hyphen AFTER truncating is deliberate: truncation can land mid-word and leave a
 * dangling '-' (e.g. a >60-char name), which slugRegex (`[a-z0-9]$`) would reject.
 * With that, the output always satisfies slugRegex, so length is the only gate left
 * (see isValidDataLakeSlug).
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
 *
 * The cap is the point. A slug may be 60 chars but a fileTagPrefix only 30, so deriving
 * straight from the slug handed the user a prefix the server refuses - and since nothing
 * client-side bounded it, the create failed at submit instead of in the form.
 *
 * The hyphen trim has to run AFTER this second cut: slugifyDataLakeName only trims once its
 * own 60-slice is done, so slicing again can re-expose a dangling '-' (cosmetic here, since
 * slugRegex governs the slug field rather than the prefix, but "triage-router-dry-run-test-:"
 * is not a prefix anyone wants stamped on every file).
 */
export function deriveTagPrefixFromLakeName(name: string): string {
  const stem = slugifyDataLakeName(name)
    .slice(0, MAX_TAG_PREFIX_LENGTH - 1)
    .replace(/-+$/, '');
  return `${stem}:`;
}

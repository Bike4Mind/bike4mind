/**
 * Serve gate for uploaded FabFiles: hold-until-scanned, fail-closed on ALL mime
 * types, not just images. A file is serveable only once moderation has run to
 * completion on it, REGARDLESS of its declared `mimeType`.
 *
 * Why gate non-images too: `mimeType` is client-declared at upload time and is only
 * corrected by the S3 scan ~1-2s later (see `moderateUploadedFile`'s byte-sniffing). If this
 * gate special-cased "non-images always serveable" based on that same untrusted declared
 * mimeType, a file uploaded as `application/pdf` but actually a PNG (or vice versa) would be
 * served during that window before the sniff/scan ever runs. Gating on `moderationStatus`
 * alone closes that window for every file, image or not.
 *
 * `moderationStatus` semantics:
 *  - 'clean'                      -> serveable
 *  - 'pending' | 'scanning'       -> NOT serveable (not yet through the scan)
 *  - 'blocked'                    -> NOT serveable (confirmed block / unscannable format)
 *  - null | undefined             -> NOT serveable (fail-closed; legacy rows are
 *                                    backfilled to 'clean', see backfill-fabfile-moderation-status.ts)
 *
 * Non-image files (PDFs, docs, text, ...) are NOT scanned by Rekognition, but they still
 * pass through `moderateUploadedFile`/`objectCreated`, which resolves them to 'clean'
 * immediately (no image bytes to hold on), so the hold is brief (one S3 event round trip),
 * not an indefinite block.
 */
export function isImageServeable(f: { mimeType?: string | null; moderationStatus?: string | null }): boolean {
  return f.moderationStatus === 'clean';
}

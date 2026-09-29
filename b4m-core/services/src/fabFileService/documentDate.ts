import { DocumentDateSource, FabFileSourceType, type IFabFile } from '@bike4mind/common';
import type { ExtractedDocumentDate } from '@bike4mind/fab-pipeline';

/** The FabFile fields the vintage precedence rule reads. */
export type DocumentDatePrecedenceInput = Pick<
  IFabFile,
  'documentDate' | 'documentDateSource' | 'sourceType' | 'driveMd5Checksum'
>;

/** Always a pair: a date is never written without its provenance, or vice versa (see FabFileTypes). */
export type ResolvedDocumentDate = {
  documentDate: Date | null;
  documentDateSource: DocumentDateSource | null;
};

/**
 * A Google Editors file that never got its DRIVE_CREATED pin (a legacy row, or a createdTime ingest
 * couldn't read). driveMd5Checksum is only ever populated for a native Drive upload (see
 * driveClient.ts), so its absence on a GOOGLE_DRIVE row identifies an Editors file.
 */
export function isUnpinnedDriveEditorsFile(file: Pick<IFabFile, 'sourceType' | 'driveMd5Checksum'>): boolean {
  return file.sourceType === FabFileSourceType.GOOGLE_DRIVE && !file.driveMd5Checksum;
}

/**
 * The vintage a content pass must write for this file when the file's bytes cannot change the
 * answer, or `undefined` when the date extracted from its bytes decides (see resolveDocumentDate).
 *
 * Split out so a caller that has not read the bytes yet, such as a metadata-only backfill, can skip
 * a download that could not change the result.
 */
export function resolveDocumentDateWithoutContent(file: DocumentDatePrecedenceInput): ResolvedDocumentDate | undefined {
  // A stored DRIVE_CREATED wins outright. That source is only ever set for a Google Editors file,
  // which has no bytes of its own: what a chunker reads is a RENDITION Drive generated at ingest.
  // Nothing in it can date the document. An exported .pptx carries a docProps/core.xml whose
  // dcterms:created is the export moment, which is exactly the ingestion-time-as-vintage answer
  // this field exists to avoid; a Sheets .xlsx export carries no docProps/ at all and a Doc
  // exports to bare text, so those two come back undated. Neither outcome may displace the date
  // Drive gave us, and on the undated ones there is nothing to re-read on a later pass, so
  // clearing it would lose the vintage permanently.
  //
  // The date is required alongside the source, not just the source: without it a row carrying a
  // DRIVE_CREATED source with no date would be rewritten with that source and a null date on every
  // pass, keeping an unattributable state alive instead of letting the pass replace it.
  if (file.documentDateSource === DocumentDateSource.DRIVE_CREATED && file.documentDate != null) {
    return { documentDate: file.documentDate, documentDateSource: file.documentDateSource };
  }

  // An Editors file that never got that pin still has no bytes of its own, so any date embedded in
  // its rendition is the export moment. There is nothing trustworthy to fall back to here.
  if (isUnpinnedDriveEditorsFile(file)) {
    return { documentDate: null, documentDateSource: null };
  }

  return undefined;
}

/**
 * Precedence (#3048): a date read from a document's own bytes outranks one taken from the container
 * that held it, so a hit normally replaces whatever ingest captured, and a miss clears a date a
 * previous content pass had set. The exceptions are the Drive Editors cases in
 * resolveDocumentDateWithoutContent.
 */
export function resolveDocumentDate(
  file: DocumentDatePrecedenceInput,
  extracted: ExtractedDocumentDate | undefined
): ResolvedDocumentDate {
  return (
    resolveDocumentDateWithoutContent(file) ?? {
      documentDate: extracted?.date ?? null,
      documentDateSource: extracted?.source ?? null,
    }
  );
}

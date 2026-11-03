import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Restore the type of legacy `.xls` uploads that the upload scan's byte sniff stored as
 * `application/x-cfb` (the OLE container every `.xls` is), and clear the zero-chunk stamp they got
 * when the chunker found no reader for that type (and the unsupported-format error, for a file the
 * new chunker reached before this ran). The un-chunked rescue sweep
 * (apps/workers/src/s3/chunkScan.ts) then picks them up and chunks them as spreadsheets.
 *
 * Idempotent: a restored row no longer matches. `down` is a no-op.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must stay last.
 */
// Must match UNSUPPORTED_FORMAT_ERROR in apps/workers/src/queueHandlers/fabFileChunk.ts.
const UNSUPPORTED_FORMAT_ERROR =
  'This file format is not supported, so the file was not indexed. Save it as PDF, DOCX, XLSX or PPTX and upload it again.';

const migration: MigrationFile = {
  id: 20260921235946,
  name: 'restore-legacy-xls-mime-type',

  up: async () => {
    const result = await FabFile.collection.updateMany(
      {
        // The leading fields ride the un-chunked sweep's index instead of scanning the collection.
        status: 'complete',
        chunkCount: 0,
        deletedAt: null,
        mimeType: 'application/x-cfb',
        fileName: /\.xls$/i,
        error: { $in: [null, '', UNSUPPORTED_FORMAT_ERROR] },
      },
      { $set: { mimeType: SupportedFabFileMimeTypes.XLS, noExtractableTextAt: null, error: null } }
    );
    console.log(`[restore-legacy-xls-mime-type] restored ${result.modifiedCount} file(s)`);
  },

  down: async () => {},
};

export default migration;

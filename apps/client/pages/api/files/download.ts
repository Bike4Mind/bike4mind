import * as os from 'os';
import * as path from 'path';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { createTempFile, zipFiles } from '@server/utils/files';
import { accessibleBy } from '@casl/mongoose';
import * as fs from 'fs';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { getContentFromFabfile, MAX_CONTENT_LENGTH } from '@client/app/utils/fabFileUtils';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { adminSettingsRepository, FabFile } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { isImageServeable, SupportedFabFileMimeTypes } from '@bike4mind/common';
import { FILES_READ_SCOPES } from '@server/files/fileScopes';

// The extractor turns these into plain text, so the entry is renamed to .txt. Text stored under
// a .pdf or .docx name does not open in the app that name promises.
const CONVERTED_TO_TEXT = new Set<string>([
  SupportedFabFileMimeTypes.PDF,
  SupportedFabFileMimeTypes.DOCX,
  SupportedFabFileMimeTypes.XLS,
  SupportedFabFileMimeTypes.XLSX,
]);

// Uncompressed UTF-8 text, so the zip stays under the ~6 MB buffered Lambda response even before
// compression and after base64.
const MAX_EXPORT_BYTES = 4_000_000;

// Uploads allow 255-character names; the index prefix and a .txt suffix would push one past the
// filesystem's per-component limit. Trims the stem by code point so a multi-byte character is
// never split, and keeps a short extension.
const capEntryName = (name: string, maxBytes = 200): string => {
  if (Buffer.byteLength(name) <= maxBytes) return name;
  const rawExt = path.extname(name);
  const ext = Buffer.byteLength(rawExt) <= 16 ? rawExt : '';
  const stem = Array.from(name.slice(0, name.length - ext.length));
  while (stem.length && Buffer.byteLength(stem.join('') + ext) > maxBytes) stem.pop();
  return stem.join('') + ext;
};

const handler = baseApi({ requiredScopes: FILES_READ_SCOPES }).get(
  asyncHandler(async (req, res) => {
    if (!req.ability) throw new ForbiddenError('Unauthorized');
    const exportable = accessibleBy(req.ability, 'export').ofType(FabFile);
    const knowledges = await FabFile.find(exportable);
    const files: string[] = [];
    let tempDir: string | undefined;

    try {
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knowledges-'));
      const outputZipPath = path.join(tempDir, 'knowledges.zip');
      let index = 0;
      // Every entry is extracted text, not the original bytes, and the extractor caps each one.
      // Anything shortened or left out is recorded so the archive can say so instead of looking
      // complete.
      const omitted: string[] = [];
      let exportedBytes = 0;
      // Read here, not via the client-side getMaxContentLength: that fetches through the browser API
      // client, whose relative URL throws Invalid URL in Node and drops to the default.
      const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
      const maxContentLength = getSettingsValue('MaxContentLength', settings, MAX_CONTENT_LENGTH);

      type ReadResult = { fileName: string; mimeType?: string; content?: string; note?: string };

      // Neither a kept nor a dropped file may fail the whole export, so a per-file problem comes
      // back as a note instead of throwing.
      const readKnowledge = async (knowledge: (typeof knowledges)[number]): Promise<ReadResult> => {
        const fileName = path.basename(knowledge.fileName);
        const mimeType = knowledge.mimeType;

        // Never bundle a held (pending scan) or blocked uploaded image into the export zip.
        if (!isImageServeable(knowledge)) {
          return { fileName, mimeType, note: 'left out, the file was still being scanned or was blocked.' };
        }

        try {
          // The stored fileUrl is a presigned URL: unset on client uploads and stale an hour
          // after it was minted, and only a read of the first page refreshes it. Sign the
          // durable object key at export time. No `audience`: this URL is fetched here, on the
          // server, so it must sign against AWS_ENDPOINT_URL_S3 rather than the browser-facing
          // S3_PRESIGN_ENDPOINT that a self-host install cannot reach from the app container.
          const fileUrl = knowledge.filePath
            ? await getFilesStorage().getSignedUrl(knowledge.filePath, 'get')
            : knowledge.fileUrl;
          // strict: a missing URL or a failed fetch must be distinguishable from empty text,
          // so the file can be skipped instead of archived as a 0-byte entry.
          const content = await getContentFromFabfile({ fileUrl, mimeType, strict: true, maxContentLength });
          // Images and unsupported binaries extract to no text at all; an empty entry would
          // only look like a successful export of an empty document.
          return content
            ? { fileName, mimeType, content }
            : { fileName, mimeType, note: 'left out, it contains no extractable text.' };
        } catch (error) {
          req.logger.warn('Skipping file in export: content unavailable', {
            fileName: knowledge.fileName,
            reason: error instanceof Error ? error.message : String(error),
          });
          return { fileName, mimeType, note: 'left out, its content could not be read.' };
        }
      };

      // Bounded batching: a few hundred files fetched one after another outlives the server
      // Lambda's 60s timeout. Batches keep that in check without unbounded fan-out.
      const BATCH_SIZE = 5;
      for (let start = 0; start < knowledges.length; start += BATCH_SIZE) {
        const batch = await Promise.all(knowledges.slice(start, start + BATCH_SIZE).map(readKnowledge));

        for (const entry of batch) {
          if (entry.content === undefined) {
            omitted.push(`${entry.fileName}: ${entry.note}`);
            continue;
          }
          const bytes = Buffer.byteLength(entry.content, 'utf8');
          if (exportedBytes + bytes > MAX_EXPORT_BYTES) {
            omitted.push(`${entry.fileName}: left out, the export reached its size limit.`);
            continue;
          }
          exportedBytes += bytes;
          // truncateContent leaves off its ellipsis when the cut ends in } or ], so a shortened entry
          // can be exactly the cap. An untouched file of exactly that length is listed too (harmless).
          if (entry.content.length >= maxContentLength) {
            omitted.push(`${entry.fileName}: shortened to the first ${maxContentLength} characters.`);
          }

          const entryName = CONVERTED_TO_TEXT.has(entry.mimeType ?? '') ? `${entry.fileName}.txt` : entry.fileName;
          files.push(await createTempFile(capEntryName(`${index++}_${entryName}`), entry.content, tempDir));
        }
      }

      if (omitted.length) {
        const manifest = [
          'This archive contains the extracted text of your knowledge files, not the original files.',
          'Images are not included, and long files are shortened.',
          '',
          'Shortened or left out:',
          '',
          ...omitted,
          '',
        ].join('\n');
        files.push(await createTempFile(`${index++}_README.txt`, manifest, tempDir));
      }

      await zipFiles(files, outputZipPath);

      // Read the zip into memory so the temp files can be removed immediately after the response.
      // The export is capped at MAX_EXPORT_BYTES of extracted text to fit the buffered-response
      // limit; archiving the original bytes would have to stream into S3 instead.
      const zipBuffer = await fs.promises.readFile(outputZipPath);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="knowledges.zip"');
      res.status(200).send(zipBuffer);
    } finally {
      if (tempDir) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

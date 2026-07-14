import { IFabFile, IFabFileVersion, SupportedFabFileMimeTypes } from '@bike4mind/common';
import axios from 'axios';
import { BadRequestError, CorruptedFileError } from './errors';
import { Logger } from '@bike4mind/observability';
import { BaseStorage } from '@bike4mind/fab-pipeline';

export const getFileContent = async (
  fabFile: Pick<IFabFile, 'mimeType' | 'fileName' | 'filePath'>,
  {
    storage,
    logger,
  }: {
    storage: BaseStorage;
    logger: Logger;
  }
): Promise<string> => {
  let content: string = '';

  // Only check status if it has the property to support legacy files
  /*
  if (fabFile.status && fabFile.status !== 'complete') {
    throw new BadRequestError('File is still being uploaded. Please try again later.');
  }
  */

  // Check for a valid file path
  if (!fabFile.filePath) {
    throw new BadRequestError('File path not found, please delete and re-upload the file.');
  }

  // Get the signed URL from fileStorage for both PDF and TXT files
  const signedUrl = await storage.getSignedUrl(fabFile.filePath);
  const { data } = await axios.get(signedUrl, {
    responseType: [
      SupportedFabFileMimeTypes.PDF,
      SupportedFabFileMimeTypes.DOCX,
      SupportedFabFileMimeTypes.XLS,
      SupportedFabFileMimeTypes.XLSX,
    ].includes(fabFile.mimeType as SupportedFabFileMimeTypes)
      ? 'arraybuffer'
      : 'text',
  });

  logger.log(fabFile.fileName, '*** The MIME type is: ', fabFile.mimeType);

  switch (fabFile.mimeType) {
    case SupportedFabFileMimeTypes.PDF:
      try {
        const { getDocumentProxy, extractText } = await import('unpdf');
        const buffer = Buffer.from(data, 'binary');
        const pdf = await getDocumentProxy(new Uint8Array(buffer.buffer));
        const { text } = await extractText(pdf, { mergePages: true });
        content = text as string;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          (error && typeof error === 'object' && 'errorType' in error && error.errorType === 'InvalidPDFException') ||
          errorMessage.includes('PDF file is empty') ||
          errorMessage.includes('size is zero bytes')
        ) {
          throw new CorruptedFileError(fabFile.fileName, 'PDF', errorMessage);
        }
        throw error;
      }
      break;
    case SupportedFabFileMimeTypes.DOCX: {
      try {
        const mammoth = await import('mammoth');
        const buffer = Buffer.from(data, 'binary');
        const result = await mammoth.extractRawText({ buffer });
        content = result.value;
        const messages = result.messages;
        if (messages.length > 0) {
          logger.warn('Mammoth message: ', messages);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('End of data reached') ||
          errorMessage.includes('Corrupted zip') ||
          errorMessage.includes('Invalid signature') ||
          errorMessage.includes('End of central directory')
        ) {
          throw new CorruptedFileError(fabFile.fileName, 'DOCX', errorMessage);
        }
        throw error;
      }
      break;
    }
    case SupportedFabFileMimeTypes.XLS:
    case SupportedFabFileMimeTypes.XLSX:
      try {
        const XLSX = await import('xlsx');
        const buffer = Buffer.from(data, 'binary');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        // Convert all sheets to text
        const allText = workbook.SheetNames.map(name => {
          const sheet = workbook.Sheets[name];
          return `Sheet: ${name}\n${XLSX.utils.sheet_to_txt(sheet)}`;
        }).join('\n\n');
        content = allText;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const fileType = fabFile.mimeType === SupportedFabFileMimeTypes.XLS ? 'XLS' : 'XLSX';
        if (
          errorMessage.includes('Invalid file format') ||
          errorMessage.includes('End of central directory') ||
          errorMessage.includes('Zip file is corrupted') ||
          errorMessage.includes('Invalid signature') ||
          errorMessage.includes('Corrupted zip') ||
          errorMessage.includes('bad central directory')
        ) {
          throw new CorruptedFileError(fabFile.fileName, fileType, errorMessage);
        }
        throw error;
      }
      break;
    case SupportedFabFileMimeTypes.TXT_PLAIN:
    case SupportedFabFileMimeTypes.TXT_MARKDOWN:
    case SupportedFabFileMimeTypes.TXT_MD_LEGACY:
    case SupportedFabFileMimeTypes.JSON:
    case SupportedFabFileMimeTypes.HTML:
    case SupportedFabFileMimeTypes.CSV:
    // Programming languages
    case SupportedFabFileMimeTypes.JS:
    case SupportedFabFileMimeTypes.JSX:
    case SupportedFabFileMimeTypes.TS:
    case SupportedFabFileMimeTypes.TSX:
    case SupportedFabFileMimeTypes.PY:
    case SupportedFabFileMimeTypes.JAVA:
    case SupportedFabFileMimeTypes.CPP:
    case SupportedFabFileMimeTypes.CS:
    case SupportedFabFileMimeTypes.PHP:
    case SupportedFabFileMimeTypes.RUBY:
    case SupportedFabFileMimeTypes.GO:
    case SupportedFabFileMimeTypes.SWIFT:
    case SupportedFabFileMimeTypes.KOTLIN:
    case SupportedFabFileMimeTypes.RUST:
    // Web technologies
    case SupportedFabFileMimeTypes.CSS:
    case SupportedFabFileMimeTypes.LESS:
    case SupportedFabFileMimeTypes.SASS:
    case SupportedFabFileMimeTypes.SCSS:
    // Data serialization
    case SupportedFabFileMimeTypes.YAML:
    case SupportedFabFileMimeTypes.TOML:
    // Shell scripts
    case SupportedFabFileMimeTypes.SH:
    case SupportedFabFileMimeTypes.BASH:
      content = data as string; // All text-based files can be handled as strings
      break;
    // Image formats - no text content to extract, stored for display only
    case SupportedFabFileMimeTypes.PNG:
    case SupportedFabFileMimeTypes.JPG:
    case SupportedFabFileMimeTypes.WEBP:
    case SupportedFabFileMimeTypes.GIF:
    case SupportedFabFileMimeTypes.SVG:
      // Images don't have extractable text content
      break;
    default:
      throw new BadRequestError(`Unsupported file type: ${fabFile.mimeType}`);
  }

  return content;
};

/** The next 1-based version number given the existing (possibly absent) version history. */
export const nextVersionNumber = (versions?: Pick<IFabFileVersion, 'version'>[]): number => {
  if (!versions || versions.length === 0) return 1;
  return Math.max(...versions.map(v => v.version)) + 1;
};

/**
 * A new, non-colliding S3 key for a file version's bytes. Versioned keys live under a
 * per-file prefix so a prior version is never overwritten, and keep the original file name
 * (extension included) so downloads stay valid.
 */
export const versionedFileKey = (params: {
  userId: string;
  fabFileId: string;
  fileName: string;
  version: number;
}): string => {
  const { userId, fabFileId, fileName, version } = params;
  return `files/${userId}/${fabFileId}/v${version}_${fileName}`;
};

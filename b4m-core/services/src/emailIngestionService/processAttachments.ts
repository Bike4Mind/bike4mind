import {
  KnowledgeType,
  IFabFileRepository,
  IAdminSettingsRepository,
  IUserRepository,
  SupportedFabFileMimeTypes,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { BadRequestError } from '@bike4mind/utils';
import { createFabFile } from '../fabFileService/create';
import { ParsedEmailObject, ProcessedAttachment, IStorageAdapter } from './types';

/**
 * Normalize a MIME type to a supported type, falling back to text/plain for unknown types.
 */
function normalizeMimeType(mimeType: string): SupportedFabFileMimeTypes {
  const supportedTypes = Object.values(SupportedFabFileMimeTypes);
  if (supportedTypes.includes(mimeType as SupportedFabFileMimeTypes)) {
    return mimeType as SupportedFabFileMimeTypes;
  }

  // Map common variations
  const mimeTypeMap: Record<string, SupportedFabFileMimeTypes> = {
    'text/x-markdown': SupportedFabFileMimeTypes.TXT_MARKDOWN,
    'application/octet-stream': SupportedFabFileMimeTypes.TXT_PLAIN,
  };

  if (mimeTypeMap[mimeType]) {
    return mimeTypeMap[mimeType];
  }

  Logger.warn(`Unknown MIME type: ${mimeType}, using text/plain as fallback`);
  return SupportedFabFileMimeTypes.TXT_PLAIN;
}

/**
 * Map email ingestion adapters to fabFile service adapters
 */
function mapToFabFileAdapters(
  storage: IStorageAdapter,
  db: {
    fabFiles: IFabFileRepository;
    adminSettings: IAdminSettingsRepository;
    users: IUserRepository;
  }
) {
  return {
    db: {
      fabFiles: {
        create: (data: any) => db.fabFiles.create(data),
      },
      adminSettings: db.adminSettings,
      users: db.users,
    },
    storage: {
      upload: (
        filepath: string,
        content: string | Buffer,
        option?: { ContentType?: string; ContentLength?: number }
      ) => {
        const payload = content ?? '';
        return storage.upload(filepath, payload, {
          ContentType: option?.ContentType,
          ContentLength: option?.ContentLength ?? Buffer.byteLength(payload),
        });
      },
      generateSignedUrl: (filepath: string, expireInSeconds: number, type?: 'get' | 'put') =>
        storage.generateSignedUrl(filepath, expireInSeconds, type),
    },
  };
}

/**
 * Process email attachments and upload to fabFiles
 *
 * Filters out inline images < 50KB and uploads substantial attachments
 * to the fabFiles service with proper metadata.
 *
 * @param parsedEmail - Parsed email object with attachments
 * @param userId - User ID for fabFile ownership
 * @param emailSubject - Email subject for fabFile notes
 * @param adapters - Storage and database adapters
 * @param organizationId - Optional organization ID for fabFile ownership
 * @returns Array of processed attachment data with fabFileIds
 */
export async function processAttachments(
  parsedEmail: ParsedEmailObject,
  userId: string,
  emailSubject: string,
  adapters: {
    storage: IStorageAdapter;
    db: {
      fabFiles: IFabFileRepository;
      adminSettings: IAdminSettingsRepository;
      users: IUserRepository;
    };
  },
  organizationId?: string
): Promise<ProcessedAttachment[]> {
  const attachmentCount = parsedEmail.attachments?.length || 0;
  Logger.info(`Processing ${attachmentCount} attachments`);

  if (!parsedEmail.attachments || parsedEmail.attachments.length === 0) {
    return [];
  }

  const processedAttachments: ProcessedAttachment[] = [];

  for (const attachment of parsedEmail.attachments) {
    try {
      // Skip unwanted MIME parts:
      // 1. Inline images/content < 50KB
      // 2. Related content (embedded images with cid: references)
      // 3. Very small files < 2KB (likely metadata)
      // 4. Specific phantom MIME types
      const shouldSkip =
        (attachment.contentDisposition === 'inline' && attachment.size < 50000) ||
        attachment.related === true || // Embedded images
        attachment.size < 2048 || // Very small files (< 2KB)
        attachment.contentType?.includes('pkcs7-signature') || // S/MIME signatures
        attachment.contentType?.includes('ms-tnef') || // Outlook metadata
        attachment.filename === 'smime.p7s' || // Digital signatures
        (attachment.filename?.startsWith('ATT') && attachment.size < 5000); // Generic metadata

      if (shouldSkip) {
        Logger.info(
          `Skipping non-attachment MIME part: ${attachment.filename} (${attachment.size} bytes, ${attachment.contentType})`
        );
        continue;
      }

      const filename = attachment.filename || 'unnamed';
      const mimeType = attachment.contentType || 'application/octet-stream';
      const size = attachment.size || 0;

      if (filename.length > 255) {
        Logger.warn(`Attachment filename too long (${filename.length} chars), truncating: ${filename}`);
        throw new BadRequestError(`Attachment filename exceeds 255 characters: ${filename.substring(0, 50)}...`);
      }

      const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
      if (size > MAX_FILE_SIZE) {
        Logger.warn(`Attachment too large: ${filename} (${size} bytes)`);
        throw new BadRequestError(`Attachment ${filename} exceeds 20MB size limit`);
      }

      if (!attachment.content || attachment.content.length === 0) {
        Logger.warn(`Attachment has no content: ${filename}`);
        throw new BadRequestError(`Attachment ${filename} has no content`);
      }

      Logger.info(`Uploading attachment: ${filename} (${size} bytes, ${mimeType})`);

      const knowledgeType = KnowledgeType.FILE;

      const normalizedMimeType = normalizeMimeType(mimeType);
      const fabFileData = {
        fileName: filename,
        content: attachment.content, // Buffer from email parser - must be 'content' not 'fileContent'
        fileSize: size,
        mimeType: normalizedMimeType,
        isPublic: false,
        type: knowledgeType,
        public: false,
        notes: `Attachment from email: ${emailSubject}`,
        organizationId,
      };

      const newFabFile = await createFabFile(userId, fabFileData, mapToFabFileAdapters(adapters.storage, adapters.db));

      Logger.info(`Attachment uploaded: ${filename} → fabFileId: ${newFabFile.id}`);

      processedAttachments.push({
        filename,
        mimeType,
        size,
        fabFileId: newFabFile.id,
      });
    } catch (error) {
      Logger.error(`Failed to upload attachment ${attachment.filename}:`, error);
      // Still capture metadata even if upload fails
      processedAttachments.push({
        filename: attachment.filename || 'unnamed',
        mimeType: attachment.contentType || 'application/octet-stream',
        size: attachment.size || 0,
      });
    }
  }

  Logger.info(`Processed ${processedAttachments.length} attachments successfully`);
  return processedAttachments;
}

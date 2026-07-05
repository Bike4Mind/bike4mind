import {
  KnowledgeType,
  IFabFileRepository,
  IAdminSettingsRepository,
  IUserRepository,
  SupportedFabFileMimeTypes,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { createFabFile } from '../fabFileService/create';
import { htmlToMarkdownForEmail, isSubstantialEmailContent } from '../lib/turndown';
import { ParsedEmailObject, ProcessedEmailBody, IStorageAdapter, EmailAddress } from './types';

/**
 * Extract formatted email address text (for notes)
 */
function getEmailAddressText(from: EmailAddress | EmailAddress[] | undefined): string {
  if (!from) return 'Unknown';

  const addresses = Array.isArray(from) ? from : [from];
  return addresses[0]?.text || 'Unknown';
}

/**
 * Process email body content and create fabFile if substantial
 *
 * Converts HTML to markdown, checks if content is substantial enough
 * to warrant a fabFile creation, and creates the fabFile with proper metadata.
 *
 * @param parsedEmail - Parsed email object
 * @param userId - User ID for fabFile ownership
 * @param emailId - Email document ID for reference
 * @param isNewsletter - Flag to force fabFile creation for newsletters
 * @param adapters - Storage and database adapters
 * @param organizationId - Optional organization ID for fabFile ownership
 * @returns Object with bodyMarkdown and optional bodyFabFileId
 */
export async function processEmailBody(
  parsedEmail: ParsedEmailObject,
  userId: string,
  emailId: string,
  isNewsletter: boolean = false,
  adapters: {
    storage: IStorageAdapter;
    db: {
      fabFiles: IFabFileRepository;
      adminSettings: IAdminSettingsRepository;
      users: IUserRepository;
    };
  },
  organizationId?: string
): Promise<ProcessedEmailBody> {
  const bodyText = parsedEmail.text || '';
  const bodyHtml = parsedEmail.html || '';

  Logger.info(`Processing email body (text: ${bodyText.length} chars, html: ${bodyHtml.length} chars)`);

  // Convert HTML to Markdown using email-specific converter
  const bodyMarkdown = htmlToMarkdownForEmail(bodyHtml || bodyText);

  const shouldCreateFabFile = isSubstantialEmailContent(bodyText, bodyHtml, isNewsletter);

  if (!shouldCreateFabFile) {
    Logger.info('Email body not substantial enough for fabFile creation');
    return { bodyMarkdown };
  }

  try {
    Logger.info('Creating fabFile for email body...');

    const subject = parsedEmail.subject || 'No Subject';
    const fromText = getEmailAddressText(parsedEmail.from);

    const fabFileData = {
      fileName: `Email: ${subject}.md`,
      content: bodyMarkdown,
      fileSize: Buffer.byteLength(bodyMarkdown),
      mimeType: SupportedFabFileMimeTypes.TXT_MARKDOWN,
      isPublic: false,
      type: KnowledgeType.FILE,
      public: false,
      notes: [
        `From: ${fromText}`,
        `Date: ${parsedEmail.date?.toISOString() || 'Unknown'}`,
        `Message-ID: ${parsedEmail.messageId || 'Unknown'}`,
      ].join('\n'),
      organizationId,
    };

    const newFabFile = await createFabFile(userId, fabFileData, {
      db: {
        fabFiles: {
          create: data => adapters.db.fabFiles.create(data),
        },
        adminSettings: adapters.db.adminSettings,
        users: adapters.db.users,
      },
      storage: {
        upload: (filepath, content, option) => {
          const payload = content ?? '';
          return adapters.storage.upload(filepath, payload, {
            ContentType: option?.ContentType || 'text/markdown',
            ContentLength: option?.ContentLength ?? Buffer.byteLength(payload, 'utf8'),
          });
        },
        generateSignedUrl: (filepath: string, expireInSeconds: number, type?: 'get' | 'put') =>
          adapters.storage.generateSignedUrl(filepath, expireInSeconds, type),
      },
    });

    Logger.info(`Email body fabFile created: ${newFabFile.id}`);

    return {
      bodyMarkdown,
      bodyFabFileId: newFabFile.id,
    };
  } catch (error) {
    Logger.error('Failed to create fabFile for email body:', error);
    return { bodyMarkdown };
  }
}

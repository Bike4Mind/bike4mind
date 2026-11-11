import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { buildFileLinkUrl } from '@bike4mind/server-utils/files/fileLinkToken';
import { v4 as uuid } from 'uuid';
import { escapeHtml } from '@client/app/utils/htmlEscape';

// EventBridge has a 256 KB limit per event
// Leave some margin for JSON overhead and other fields
const EVENTBRIDGE_SAFE_LIMIT = 230 * 1024;

// The fab-file bucket's expire-shared-email-files lifecycle rule (infra/buckets.ts) reaps this prefix,
// so it must outlive the link TTL; infra/__tests__/fabFileBucketLifecycle.test.ts pins both.
export const SHARED_EMAIL_FILES_PREFIX = 'shared-email-files/';
export const SHARED_EMAIL_FILE_LINK_TTL_DAYS = 7;

interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface EmailOptions {
  to: string;
  subject: string;
  body: string;
  attachments: EmailAttachment[];
}

interface SharedFileInfo {
  filename: string;
  downloadUrl: string;
  expiresIn: string;
  size: number;
}

/**
 * Calculate the size of the email when sent through EventBridge
 * This includes base64 encoding overhead and JSON serialization
 */
function calculateEventBridgeSize(emailBody: string, attachments: EmailAttachment[]): number {
  const bodySize = Buffer.byteLength(emailBody, 'utf8');

  // Attachments are base64 encoded (33% size increase) + JSON overhead
  const attachmentsSize = attachments.reduce((total, att) => {
    const base64Size = Math.ceil((att.content.length * 4) / 3);
    const jsonOverhead = Buffer.byteLength(
      JSON.stringify({
        filename: att.filename,
        contentType: att.contentType,
        encoding: 'base64',
      }),
      'utf8'
    );
    return total + base64Size + jsonOverhead;
  }, 0);

  const metadataOverhead = 1024; // 1 KB for subject, to, etc.

  return bodySize + attachmentsSize + metadataOverhead;
}

/** Upload files to S3 and link each through the app's file-link route, valid for the link TTL. */
async function uploadFilesAndGenerateLinks(attachments: EmailAttachment[], userId: string): Promise<SharedFileInfo[]> {
  const uploadPromises = attachments.map(async att => {
    const timestamp = Date.now();
    const randomId = uuid().slice(0, 8);
    const sanitizedFilename = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const s3Path = `${SHARED_EMAIL_FILES_PREFIX}${userId}/${timestamp}-${randomId}/${sanitizedFilename}`;

    await getFilesStorage().upload(att.content, s3Path, {
      ContentType: att.contentType,
      ContentDisposition: `attachment; filename="${att.filename}"`,
    });

    return {
      filename: att.filename,
      downloadUrl: buildFileLinkUrl(
        { kind: 'filesKey', key: s3Path },
        userId,
        SHARED_EMAIL_FILE_LINK_TTL_DAYS * 24 * 60 * 60
      ),
      expiresIn: `${SHARED_EMAIL_FILE_LINK_TTL_DAYS} days`,
      size: att.content.length,
    };
  });

  return await Promise.all(uploadPromises);
}

/**
 * Generate HTML email body with download links
 */
function generateDownloadLinksEmail(originalBody: string, sharedFiles: SharedFileInfo[], userName: string): string {
  // Omit the brand sentence entirely when APP_NAME is unconfigured.
  const brand = process.env.APP_NAME || '';
  const sentFromLine = brand ? `<p>This email was sent from ${brand}, an AI collaboration platform.</p>` : '';
  const filesList = sharedFiles
    .map(
      file => `
    <li style="margin: 10px 0;">
      <a href="${file.downloadUrl}"
         style="color: #1976d2; text-decoration: none; font-weight: 500;">
        📎 ${escapeHtml(file.filename)}
      </a>
      <span style="color: #666; font-size: 12px; margin-left: 8px;">
        (${(file.size / 1024).toFixed(1)} KB)
      </span>
    </li>
  `
    )
    .join('');

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header {
            border-bottom: 3px solid #1976d2;
            padding-bottom: 20px;
            margin-bottom: 30px;
          }
          .content {
            margin: 20px 0;
          }
          .download-section {
            background-color: #f5f5f5;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
            border-left: 4px solid #1976d2;
          }
          .download-section ul {
            list-style: none;
            padding: 0;
            margin: 15px 0;
          }
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #666666;
          }
          .alert {
            background-color: #fff3cd;
            border: 1px solid #ffc107;
            border-radius: 4px;
            padding: 12px;
            margin: 15px 0;
            color: #856404;
          }
          h1 {
            color: #1976d2;
            font-size: 24px;
            margin: 0;
          }
        </style>
      </head>
      <body>
        ${originalBody.replace('</body>', '')}

        <div class="download-section">
          <h3 style="margin-top: 0; color: #1976d2;">📥 Download Files</h3>
          <p style="margin: 10px 0;">
            The files are too large to attach directly. Click below to download:
          </p>
          <ul>
            ${filesList}
          </ul>
          <div class="alert">
            <strong>Note:</strong> Download links expire in ${SHARED_EMAIL_FILE_LINK_TTL_DAYS} days.
          </div>
        </div>

        <div class="footer">
          ${sentFromLine}
          <p>If you have questions about these files, please contact ${escapeHtml(userName)}.</p>
        </div>
      </body>
    </html>
  `;
}

/**
 * Send email with attachments, automatically choosing the best method:
 * - Small emails: Send via EventBridge with attachments
 * - Large emails: Upload to S3, send download links via EventBridge (no attachments)
 */
export async function sendEmailWithAttachments(
  options: EmailOptions,
  userId: string,
  userName: string
): Promise<{ method: 'direct-attachment' | 'download-links'; filesUploaded?: boolean }> {
  const { to, subject, body, attachments } = options;

  const totalSize = calculateEventBridgeSize(body, attachments);

  const { EmailEvents } = await import('@bike4mind/server-utils/utils/eventBus');

  if (totalSize <= EVENTBRIDGE_SAFE_LIMIT) {
    await EmailEvents.Send.publish({
      to,
      subject,
      body,
      attachments: attachments.map(att => ({
        filename: att.filename,
        content: att.content.toString('base64'),
        encoding: 'base64',
        contentType: att.contentType,
      })),
    });

    return { method: 'direct-attachment' };
  }

  const sharedFiles = await uploadFilesAndGenerateLinks(attachments, userId);
  const emailBodyWithLinks = generateDownloadLinksEmail(body, sharedFiles, userName);

  await EmailEvents.Send.publish({
    to,
    subject,
    body: emailBodyWithLinks,
    // No attachments - just download links in the email body
  });

  return { method: 'download-links', filesUploaded: true };
}

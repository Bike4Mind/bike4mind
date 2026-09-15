import { sessionRepository, fabFileRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { EmailSendRequestSchema } from '../../../types/api';
import { getFilesStorage } from '@server/utils/storage';
import { notebookCurationService } from '@bike4mind/services';
import { Permission, isImageServeable } from '@bike4mind/common';
import { z } from 'zod';
import { sendEmailWithAttachments } from '@server/utils/mailer/emailAttachments';

const handler = baseApi().post(async (req, res) => {
  try {
    const brand = process.env.APP_NAME || '';
    const userId = req.user?.id;
    const userName = req.user?.name || `A${brand ? ` ${brand}` : ''} user`;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    // Validate request body
    let validatedBody: z.infer<typeof EmailSendRequestSchema>;
    try {
      validatedBody = EmailSendRequestSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          message: 'Invalid request body',
          errors: error.issues.map(err => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      throw error;
    }

    const { recipients, message: customMessage } = validatedBody;

    // Handle based on type
    if (validatedBody.type === 'files') {
      return await handleFileEmail(req, res, validatedBody.fileIds, recipients, customMessage, userId, userName);
    } else {
      return await handleNotebookEmail(
        req,
        res,
        validatedBody.sessionIds,
        recipients,
        validatedBody.format,
        customMessage,
        userId,
        userName
      );
    }
  } catch (error) {
    req.logger.error('Failed to send email', { error, userId: req.user?.id });
    return res.status(500).json({
      success: false,
      message: 'Failed to send email. Please try again later.',
    });
  }
});

async function handleFileEmail(
  req: any,
  res: any,
  fileIds: string[],
  recipients: string[],
  customMessage: string | undefined,
  userId: string,
  userName: string
) {
  // Verify all files exist and belong to user (or are shared with user)
  const files = await Promise.all(fileIds.map(fileId => fabFileRepository.findById(fileId)));

  const invalidFiles: string[] = [];
  const unauthorizedFiles: string[] = [];

  files.forEach((file, index) => {
    const fileId = fileIds[index];
    if (!file) {
      invalidFiles.push(fileId);
    } else {
      // Check if user owns the file or has access to it
      const isOwner = file.userId === userId;
      const hasAccess = file.users?.some(
        u =>
          u.userId === userId && (u.permissions.includes(Permission.read) || u.permissions.includes(Permission.update))
      );
      if (!isOwner && !hasAccess) {
        unauthorizedFiles.push(fileId);
      }
    }
  });

  if (invalidFiles.length > 0) {
    return res.status(404).json({
      success: false,
      message: `File(s) not found: ${invalidFiles.join(', ')}`,
    });
  }

  if (unauthorizedFiles.length > 0) {
    return res.status(403).json({
      success: false,
      message: `You do not have permission to email file(s): ${unauthorizedFiles.join(', ')}`,
    });
  }

  // Prepare attachments for email
  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  const fileNames: string[] = [];

  req.logger.info('Preparing files for email', { fileIds, recipients, userId });

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const fileId = fileIds[i];

    // Check if file has content
    if (!file.filePath) {
      req.logger.warn('Skipping file without filePath', { fileId });
      continue;
    }

    // Refuse to email a held/blocked uploaded image.
    if (!isImageServeable(file)) {
      req.logger.warn('Skipping non-serveable image', { fileId, moderationStatus: file.moderationStatus });
      continue;
    }

    // Only list files that actually make it into the attachments below - a
    // skipped (missing filePath / non-serveable) file must not appear as "attached".
    fileNames.push(file.fileName);

    try {
      // Download file content
      const fileContent = await getFilesStorage().download(file.filePath);

      // Sanitize filename
      const sanitizedName = file.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      attachments.push({
        filename: sanitizedName,
        content: fileContent,
        contentType: file.mimeType || 'application/octet-stream',
      });
    } catch (error) {
      req.logger.error('Failed to download file', { fileId, error });
      // Continue with other files
    }
  }

  if (attachments.length === 0) {
    return res.status(500).json({
      success: false,
      message: 'Failed to prepare any files for email',
    });
  }

  // Build email subject and body
  const brand = process.env.APP_NAME || '';
  const subject =
    fileNames.length === 1
      ? `Shared File: ${fileNames[0]}`
      : `${fileNames.length} Shared Files${brand ? ` from ${brand}` : ''}`;

  const filesList = fileNames.map(name => `<li>${name}</li>`).join('\n');

  const emailBody = `
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
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #666666;
          }
          h1 {
            color: #1976d2;
            font-size: 24px;
            margin: 0;
          }
          .files-list {
            background-color: #f5f5f5;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
          }
          .files-list ul {
            margin: 10px 0;
            padding-left: 20px;
          }
          .custom-message {
            background-color: #e3f2fd;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #1976d2;
            margin: 20px 0;
            font-style: italic;
          }
          .stats {
            color: #666;
            font-size: 14px;
            margin: 10px 0;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>📎 Shared File${fileNames.length > 1 ? 's' : ''}</h1>
        </div>

        <div class="content">
          <p>Hello!</p>

          <p>${userName} has shared ${fileNames.length === 1 ? 'a file' : `${fileNames.length} files`} with you${brand ? ` from ${brand}` : ''}.</p>

          ${
            customMessage
              ? `
          <div class="custom-message">
            <strong>Personal message:</strong><br/>
            ${customMessage.replace(/\n/g, '<br/>')}
          </div>
          `
              : ''
          }

          <div class="files-list">
            <strong>${fileNames.length === 1 ? 'File' : 'Files'}:</strong>
            <ul>
              ${filesList}
            </ul>
          </div>

          <p class="stats">
            📎 <strong>${attachments.length}</strong> file${attachments.length > 1 ? 's' : ''} attached
          </p>
        </div>

        <div class="footer">
          <p>This email was sent${brand ? ` from ${brand}, an AI collaboration platform` : ''}.</p>
          <p>If you have questions about these files, please contact ${userName}.</p>
        </div>
      </body>
    </html>
  `;

  // Send emails to all recipients
  const emailPromises = recipients.map(async recipient => {
    try {
      const result = await sendEmailWithAttachments(
        {
          to: recipient,
          subject,
          body: emailBody,
          attachments,
        },
        req.user?.email || 'unknown',
        userName
      );

      req.logger.info('Email sent successfully', {
        recipient,
        fileIds,
        attachmentCount: attachments.length,
        method: result.method,
        filesUploaded: result.filesUploaded,
      });

      return { recipient, success: true, method: result.method };
    } catch (error) {
      req.logger.error('Failed to send email to recipient', { recipient, error });
      return { recipient, success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  const results = await Promise.all(emailPromises);
  const successCount = results.filter(r => r.success).length;
  const failedCount = results.filter(r => !r.success).length;

  req.logger.info('Email batch completed', {
    fileIds,
    totalRecipients: recipients.length,
    successCount,
    failedCount,
  });

  if (failedCount === recipients.length) {
    return res.status(500).json({
      success: false,
      message: 'Failed to send email to any recipients',
      data: { results },
    });
  }

  return res.status(200).json({
    success: true,
    message: `Email sent successfully to ${successCount} recipient${successCount > 1 ? 's' : ''}${failedCount > 0 ? `, failed for ${failedCount}` : ''}`,
    data: {
      fileIds,
      recipients: results,
      fileCount: fileNames.length,
      attachmentCount: attachments.length,
    },
  });
}

async function handleNotebookEmail(
  req: any,
  res: any,
  sessionIds: string[],
  recipients: string[],
  format: 'markdown' | 'txt' | 'html',
  customMessage: string | undefined,
  userId: string,
  userName: string
) {
  // Verify all sessions exist and belong to user
  const sessions = await Promise.all(sessionIds.map(sessionId => sessionRepository.findById(sessionId)));

  const invalidSessions: string[] = [];
  const unauthorizedSessions: string[] = [];
  const uncuratedSessions: string[] = [];

  sessions.forEach((session, index) => {
    const sessionId = sessionIds[index];
    if (!session) {
      invalidSessions.push(sessionId);
    } else if (session.userId !== userId) {
      unauthorizedSessions.push(sessionId);
    } else if (!session.curatedNotebookFileId) {
      uncuratedSessions.push(sessionId);
    }
  });

  if (invalidSessions.length > 0) {
    return res.status(404).json({
      success: false,
      message: `Session(s) not found: ${invalidSessions.join(', ')}`,
    });
  }

  if (unauthorizedSessions.length > 0) {
    return res.status(403).json({
      success: false,
      message: `You do not have permission to email session(s): ${unauthorizedSessions.join(', ')}`,
    });
  }

  if (uncuratedSessions.length > 0) {
    return res.status(404).json({
      success: false,
      message: `No curated notebook found for session(s): ${uncuratedSessions.join(', ')}. Please curate first.`,
    });
  }

  // Prepare attachments for email
  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  const sessionNames: string[] = [];

  req.logger.info('Preparing curated notebooks for email', {
    sessionIds,
    recipients,
    format,
    userId,
  });

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    const sessionId = sessionIds[i];
    sessionNames.push(session.name || 'Untitled Session');

    // Get FabFile
    const fabFile = await fabFileRepository.findById(session.curatedNotebookFileId!);
    if (!fabFile || !fabFile.filePath) {
      req.logger.warn('Skipping session with missing file', { sessionId });
      continue;
    }

    // Download markdown content
    const markdownContent = await getFilesStorage().download(fabFile.filePath);
    let fileContent: Buffer;
    let fileName: string;
    let mimeType: string;

    // Convert if needed
    if (format !== 'markdown') {
      const markdownText = markdownContent.toString('utf-8');
      const converter = new notebookCurationService.FormatConverter(req.logger);
      const converted = await converter.convert(markdownText, format);
      fileContent = Buffer.isBuffer(converted.content) ? converted.content : Buffer.from(converted.content);
      const baseFileName = fabFile.fileName.replace(/\.md$/, '');
      fileName = `${baseFileName}${converted.extension}`;
      mimeType = converted.mimeType;
    } else {
      fileContent = markdownContent;
      fileName = fabFile.fileName;
      mimeType = fabFile.mimeType || 'text/markdown';
    }

    // Sanitize filename
    const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    attachments.push({
      filename: sanitizedName,
      content: fileContent,
      contentType: mimeType,
    });
  }

  if (attachments.length === 0) {
    return res.status(500).json({
      success: false,
      message: 'Failed to prepare any notebooks for email',
    });
  }

  // Build email subject and body
  const brand = process.env.APP_NAME || '';
  const subject =
    sessionNames.length === 1
      ? `Curated Notebook: ${sessionNames[0]}`
      : `${sessionNames.length} Curated Notebooks${brand ? ` from ${brand}` : ''}`;

  const sessionsList = sessionNames.map(name => `<li>${name}</li>`).join('\n');

  const emailBody = `
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
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #666666;
          }
          h1 {
            color: #1976d2;
            font-size: 24px;
            margin: 0;
          }
          .sessions-list {
            background-color: #f5f5f5;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
          }
          .sessions-list ul {
            margin: 10px 0;
            padding-left: 20px;
          }
          .custom-message {
            background-color: #e3f2fd;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #1976d2;
            margin: 20px 0;
            font-style: italic;
          }
          .stats {
            color: #666;
            font-size: 14px;
            margin: 10px 0;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>📚 Curated Notebook${sessionNames.length > 1 ? 's' : ''}</h1>
        </div>

        <div class="content">
          <p>Hello!</p>

          <p>${userName} has shared ${sessionNames.length === 1 ? 'a curated notebook' : `${sessionNames.length} curated notebooks`} with you${brand ? ` from ${brand}` : ''}.</p>

          ${
            customMessage
              ? `
          <div class="custom-message">
            <strong>Personal message:</strong><br/>
            ${customMessage.replace(/\n/g, '<br/>')}
          </div>
          `
              : ''
          }

          <div class="sessions-list">
            <strong>${sessionNames.length === 1 ? 'Notebook' : 'Notebooks'}:</strong>
            <ul>
              ${sessionsList}
            </ul>
          </div>

          <p class="stats">
            📎 <strong>${attachments.length}</strong> file${attachments.length > 1 ? 's' : ''} attached (${format.toUpperCase()} format)
          </p>

          <p>These notebooks contain AI-curated conversations with artifacts, code snippets, and insights extracted and organized for easy reference.</p>
        </div>

        <div class="footer">
          <p>This email was sent${brand ? ` from ${brand}, an AI collaboration platform` : ''}.</p>
          <p>If you have questions about these notebooks, please contact ${userName}.</p>
        </div>
      </body>
    </html>
  `;

  // Send emails to all recipients
  const emailPromises = recipients.map(async recipient => {
    try {
      const result = await sendEmailWithAttachments(
        {
          to: recipient,
          subject,
          body: emailBody,
          attachments,
        },
        req.user?.email || 'unknown',
        userName
      );

      req.logger.info('Email sent successfully', {
        recipient,
        sessionIds,
        attachmentCount: attachments.length,
        method: result.method,
        filesUploaded: result.filesUploaded,
      });

      return { recipient, success: true, method: result.method };
    } catch (error) {
      req.logger.error('Failed to send email to recipient', { recipient, error });
      return { recipient, success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  const results = await Promise.all(emailPromises);
  const successCount = results.filter(r => r.success).length;
  const failedCount = results.filter(r => !r.success).length;

  req.logger.info('Email batch completed', {
    sessionIds,
    totalRecipients: recipients.length,
    successCount,
    failedCount,
  });

  if (failedCount === recipients.length) {
    return res.status(500).json({
      success: false,
      message: 'Failed to send email to any recipients',
      data: { results },
    });
  }

  return res.status(200).json({
    success: true,
    message: `Email sent successfully to ${successCount} recipient${successCount > 1 ? 's' : ''}${failedCount > 0 ? `, failed for ${failedCount}` : ''}`,
    data: {
      sessionIds,
      recipients: results,
      notebookCount: sessionNames.length,
      attachmentCount: attachments.length,
      format,
    },
  });
}

export default handler;

// Export configuration
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb', // Larger size limit for file attachments
    },
    externalResolver: true,
  },
};

import { sessionRepository, fabFileRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { NotebookDownloadRequestSchema } from '../../../types/api';
import { getFilesStorage } from '@server/utils/storage';
import { notebookCurationService } from '@bike4mind/services';
import { z } from 'zod';
import archiver from 'archiver';

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    let validatedBody: z.infer<typeof NotebookDownloadRequestSchema>;
    try {
      validatedBody = NotebookDownloadRequestSchema.parse(req.body);
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

    const { sessionIds, format = 'markdown', downloadAsZip = false } = validatedBody;

    try {
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
          message: `You do not have permission to download session(s): ${unauthorizedSessions.join(', ')}`,
        });
      }

      if (uncuratedSessions.length > 0) {
        return res.status(404).json({
          success: false,
          message: `No curated notebook found for session(s): ${uncuratedSessions.join(', ')}. Please curate first.`,
        });
      }

      if (sessionIds.length > 1 && downloadAsZip) {
        req.logger.info('Creating zip archive for batch download', {
          sessionIds,
          userId,
          format,
        });

        try {
          const archive = archiver('zip', {
            zlib: { level: 9 }, // max compression
          });

          const filesToArchive: Array<{ content: Buffer; name: string }> = [];

          for (let i = 0; i < sessions.length; i++) {
            const session = sessions[i]!;
            const sessionId = sessionIds[i];

            const fabFile = await fabFileRepository.findById(session.curatedNotebookFileId!);
            if (!fabFile || !fabFile.filePath) {
              req.logger.warn('Skipping session with missing file', { sessionId });
              continue;
            }

            const currentFormat =
              fabFile.fileName.endsWith('.html') || fabFile.mimeType === 'text/html'
                ? 'html'
                : fabFile.fileName.endsWith('.txt') || fabFile.mimeType === 'text/plain'
                  ? 'txt'
                  : 'markdown';

            const fileContentBuffer = await getFilesStorage().download(fabFile.filePath);
            let fileContent: Buffer;
            let fileName: string;

            const needsConversion = format !== currentFormat;
            if (needsConversion) {
              // conversion only supports markdown as the source format
              if (currentFormat !== 'markdown') {
                req.logger.warn('Skipping session - cannot convert from non-markdown format', {
                  sessionId,
                  currentFormat,
                  requestedFormat: format,
                });
                continue;
              }

              const fileText = fileContentBuffer.toString('utf-8');
              const converter = new notebookCurationService.FormatConverter(req.logger);
              const converted = await converter.convert(fileText, format);
              fileContent = Buffer.isBuffer(converted.content) ? converted.content : Buffer.from(converted.content);
              // strip existing extension before appending the converted one
              const baseFileName = fabFile.fileName.replace(/\.(md|txt|html)$/, '');
              fileName = `${baseFileName}${converted.extension}`;
            } else {
              fileContent = fileContentBuffer;
              fileName = fabFile.fileName;
            }

            const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
            filesToArchive.push({ content: fileContent, name: sanitizedName });
          }

          filesToArchive.forEach(file => {
            archive.append(file.content, { name: file.name });
          });

          await archive.finalize();

          const chunks: Buffer[] = [];
          archive.on('data', (chunk: Buffer) => chunks.push(chunk));

          await new Promise<void>((resolve, reject) => {
            archive.on('end', resolve);
            archive.on('error', reject);
          });

          const zipBuffer = Buffer.concat(chunks);

          const zipFileName = `curated-notebooks-${Date.now()}.zip`;
          const zipFilePath = `curated-notebooks/${userId}/batches/${zipFileName}`;

          await getFilesStorage().upload(zipBuffer, zipFilePath, {
            ContentType: 'application/zip',
          });

          const signedUrl = await getFilesStorage().getSignedUrl(zipFilePath, 'get', {
            expiresIn: 3600,
            ResponseContentDisposition: `attachment; filename="${zipFileName}"`,
          });

          req.logger.info('Generated batch download URL', {
            sessionIds,
            userId,
            fileName: zipFileName,
            fileCount: filesToArchive.length,
          });

          return res.status(200).json({
            success: true,
            message: 'Batch download URL generated successfully',
            data: {
              downloadUrl: signedUrl,
              fileName: zipFileName,
              fileSize: zipBuffer.length,
              mimeType: 'application/zip',
              fileCount: filesToArchive.length,
              expiresIn: 3600,
            },
          });
        } catch (error) {
          req.logger.error('Failed to create zip archive', { error, sessionIds, userId });
          return res.status(500).json({
            success: false,
            message: `Failed to create zip archive. ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }

      // single file download (or first session if not zipping)
      const session = sessions[0]!;
      const sessionId = sessionIds[0];

      const fabFile = await fabFileRepository.findById(session.curatedNotebookFileId!);
      if (!fabFile) {
        req.logger.error('FabFile not found for curated notebook', {
          sessionId,
          curatedNotebookFileId: session.curatedNotebookFileId,
        });
        return res.status(404).json({
          success: false,
          message: 'Curated notebook file not found',
        });
      }

      if (!fabFile.filePath) {
        req.logger.error('FabFile has no file path', {
          sessionId,
          fabFileId: fabFile.id,
        });
        return res.status(500).json({
          success: false,
          message: 'Curated notebook file path is missing',
        });
      }

      let finalFilePath = fabFile.filePath;
      let fileName = fabFile.fileName;
      let mimeType = fabFile.mimeType || 'text/markdown';
      let fileSize = fabFile.fileSize;

      const currentFormat =
        fileName.endsWith('.html') || mimeType === 'text/html'
          ? 'html'
          : fileName.endsWith('.txt') || mimeType === 'text/plain'
            ? 'txt'
            : 'markdown';

      const needsConversion = format !== currentFormat;

      if (needsConversion) {
        try {
          req.logger.info(`Converting ${currentFormat} to ${format}`, { sessionId, format, currentFormat });

          const fileContent = await getFilesStorage().download(fabFile.filePath);
          const fileText = fileContent.toString('utf-8');

          // Can't reliably convert between two non-markdown formats without the original markdown
          if (currentFormat !== 'markdown' && format !== 'markdown') {
            req.logger.warn('Cannot convert between non-markdown formats', {
              sessionId,
              currentFormat,
              requestedFormat: format,
            });
            return res.status(400).json({
              success: false,
              message: `Cannot convert from ${currentFormat.toUpperCase()} to ${format.toUpperCase()}. The file was curated as ${currentFormat.toUpperCase()}.`,
            });
          }

          // conversion requires markdown as the source format
          const converter = new notebookCurationService.FormatConverter(req.logger);
          const converted = await converter.convert(fileText, format);

          // strip existing extension before appending the converted one
          const baseFileName = fabFile.fileName.replace(/\.(md|txt|html)$/, '');
          const convertedFileName = `${baseFileName}${converted.extension}`;
          const convertedFilePath = `curated-notebooks/${userId}/${sessionId}/${convertedFileName}`;

          await getFilesStorage().upload(converted.content, convertedFilePath, {
            ContentType: converted.mimeType,
          });

          req.logger.info('Converted file uploaded to S3', {
            originalPath: fabFile.filePath,
            convertedPath: convertedFilePath,
            format,
          });

          finalFilePath = convertedFilePath;
          fileName = convertedFileName;
          mimeType = converted.mimeType;
          fileSize = Buffer.isBuffer(converted.content)
            ? converted.content.length
            : Buffer.byteLength(converted.content);
        } catch (error) {
          req.logger.error('Format conversion failed', { error, format, sessionId });
          return res.status(500).json({
            success: false,
            message: `Failed to convert notebook to ${format.toUpperCase()}. ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      } else {
        req.logger.info('File already in requested format, skipping conversion', {
          sessionId,
          format,
          fileName,
        });
      }

      // force download via Content-Disposition instead of rendering in-browser
      const signedUrl = await getFilesStorage().getSignedUrl(finalFilePath, 'get', {
        expiresIn: 3600,
        ResponseContentDisposition: `attachment; filename="${fileName}"`,
      });

      req.logger.info('Generated download URL for curated notebook', {
        sessionId,
        userId,
        fabFileId: fabFile.id,
        fileName,
        format,
      });

      return res.status(200).json({
        success: true,
        message: 'Download URL generated successfully',
        data: {
          downloadUrl: signedUrl,
          fileName,
          fileSize,
          mimeType,
          curatedAt: session.curatedAt,
          expiresIn: 3600,
        },
      });
    } catch (error) {
      req.logger.error('Failed to generate download URL for curated notebook(s)', { sessionIds, userId, error });

      return res.status(500).json({
        success: false,
        message: 'Failed to generate download URL. Please try again later.',
      });
    }
  })
);

export default handler;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
    externalResolver: true,
  },
};

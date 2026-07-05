import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { AppFile, User } from '@bike4mind/database';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { AppFileReservedTags } from '@bike4mind/common';
import { isValidDocxMimeType, MAX_DOCX_TEMPLATE_SIZE } from '@server/services/docxTemplateService';

const SetTemplateSchema = z.object({
  fileId: z.string().min(1, 'File ID is required'),
});

const handler = baseApi()
  // Set the user's DOCX template
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const userId = req.query.id;
      const requestingUserId = req.user?.id;

      // Users can only update their own settings (or admins can update any)
      if (userId?.toString() !== requestingUserId?.toString() && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Not authorized to update template settings' });
      }

      try {
        const { fileId } = SetTemplateSchema.parse(req.body);

        // Verify file exists and belongs to user
        const appFile = await AppFile.findById(fileId);
        if (!appFile) {
          return res.status(404).json({ error: 'Template file not found' });
        }

        // Verify ownership
        if (appFile.userId?.toString() !== userId?.toString() && !req.user?.isAdmin) {
          return res.status(403).json({ error: 'Not authorized to use this file as template' });
        }

        // Validate MIME type
        if (!isValidDocxMimeType(appFile.mimeType)) {
          return res.status(400).json({
            error: 'Invalid file type. Must be .docx or .dotx',
            receivedType: appFile.mimeType,
          });
        }

        // Validate file size (server-side check)
        if (appFile.size > MAX_DOCX_TEMPLATE_SIZE) {
          return res.status(400).json({
            error: 'Template file exceeds 10MB limit',
            fileSize: appFile.size,
          });
        }

        // Update file with template tag (if not already present)
        const currentTags = appFile.tags || [];
        if (!currentTags.includes(AppFileReservedTags.DocxTemplate)) {
          await AppFile.findByIdAndUpdate(fileId, {
            $addToSet: { tags: AppFileReservedTags.DocxTemplate },
          });
        }

        // Update user preferences with template file ID
        const updatedUser = await User.findByIdAndUpdate(
          userId,
          {
            $set: { 'preferences.docxTemplateFileId': fileId },
          },
          { new: true, runValidators: true }
        ).select('preferences');

        if (!updatedUser) {
          return res.status(404).json({ error: 'User not found' });
        }

        Logger.info(`Set DOCX template for user ${userId}`, { fileId, fileName: appFile.name });

        return res.json({
          message: 'DOCX template set successfully',
          template: {
            fileId,
            fileName: appFile.name,
            fileSize: appFile.size,
          },
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({
            error: 'Invalid request data',
            details: error.issues,
          });
        }

        Logger.error('Error setting DOCX template:', error);
        return res.status(500).json({ error: 'Failed to set template' });
      }
    })
  )
  // Remove the user's DOCX template
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const userId = req.query.id;
      const requestingUserId = req.user?.id;

      // Users can only update their own settings (or admins can update any)
      if (userId?.toString() !== requestingUserId?.toString() && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Not authorized to update template settings' });
      }

      try {
        // Get current template file ID before clearing
        const user = await User.findById(userId).select('preferences.docxTemplateFileId');
        const previousFileId = user?.preferences?.docxTemplateFileId;

        // Clear the template preference
        const updatedUser = await User.findByIdAndUpdate(
          userId,
          {
            $unset: { 'preferences.docxTemplateFileId': '' },
          },
          { new: true }
        );

        if (!updatedUser) {
          return res.status(404).json({ error: 'User not found' });
        }

        // Remove the template tag from the file if it exists
        if (previousFileId) {
          await AppFile.findByIdAndUpdate(previousFileId, {
            $pull: { tags: AppFileReservedTags.DocxTemplate },
          });
        }

        Logger.info(`Removed DOCX template for user ${userId}`, { previousFileId });

        return res.json({
          message: 'DOCX template removed successfully',
        });
      } catch (error) {
        Logger.error('Error removing DOCX template:', error);
        return res.status(500).json({ error: 'Failed to remove template' });
      }
    })
  )
  // Get the user's current DOCX template info
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const userId = req.query.id;
      const requestingUserId = req.user?.id;

      // Users can only view their own settings (or admins can view any)
      if (userId?.toString() !== requestingUserId?.toString() && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Not authorized to view template settings' });
      }

      try {
        const user = await User.findById(userId).select('preferences.docxTemplateFileId');
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        const fileId = user.preferences?.docxTemplateFileId;
        if (!fileId) {
          return res.json({ template: null });
        }

        // Get file details
        const appFile = await AppFile.findById(fileId).select('name size mimeType');
        if (!appFile) {
          // Template file was deleted, clear the preference
          await User.findByIdAndUpdate(userId, {
            $unset: { 'preferences.docxTemplateFileId': '' },
          });
          return res.json({ template: null });
        }

        return res.json({
          template: {
            fileId,
            fileName: appFile.name,
            fileSize: appFile.size,
            mimeType: appFile.mimeType,
          },
        });
      } catch (error) {
        Logger.error('Error fetching DOCX template info:', error);
        return res.status(500).json({ error: 'Failed to fetch template info' });
      }
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

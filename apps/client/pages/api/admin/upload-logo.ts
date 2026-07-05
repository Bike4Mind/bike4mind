import {
  AppFileReservedTags,
  FileGeneratePresignedUrlRequestInput,
  LogoSettings,
  settingsMap,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { AppFile } from '@bike4mind/database/content';
import { AdminSettings } from '@bike4mind/database/infra';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { Resource } from 'sst';
import { z } from 'zod';

// Extended schema to support dark mode logo uploads
const AdminLogoUploadInput = FileGeneratePresignedUrlRequestInput.extend({
  isDarkMode: z.boolean().optional().prefault(false),
  useBothLogos: z.boolean().optional().prefault(false),
});

async function getLogoSettings(session?: any): Promise<LogoSettings> {
  const logoSettingsDoc = await AdminSettings.findOne({ settingName: 'logoSettings' }).session(session);

  if (logoSettingsDoc?.settingValue) {
    // Use schema from settingsMap which handles JSON string parsing via z.preprocess
    const parsed = settingsMap.logoSettings.schema.safeParse(logoSettingsDoc.settingValue);
    if (parsed.success) {
      return parsed.data;
    }
    console.warn('Failed to parse logo settings, using defaults');
  }

  return {
    customLogoUrl: '',
    customDarkLogoUrl: '',
    useBothLogos: false,
  };
}

async function updateLogoSettings(newSettings: Partial<LogoSettings>, session?: any): Promise<void> {
  const currentSettings = await getLogoSettings(session);
  const updatedSettings = { ...currentSettings, ...newSettings };

  // Store as object directly (consistent with settings/update.ts)
  // The schema's z.preprocess handles both object and JSON string formats when reading
  await AdminSettings.findOneAndUpdate(
    { settingName: 'logoSettings' },
    {
      settingName: 'logoSettings',
      settingValue: updatedSettings,
      updatedAt: new Date(),
    },
    { upsert: true, session }
  );
}

/**
 * Lambda function to generate S3 signed URL for uploading custom admin logo
 */
const handler = baseApi()
  .post(async (req, res) => {
    try {
      const { user } = req;

      // Only allow admin users to upload admin logos
      if (!user?.isAdmin) {
        throw new ForbiddenError('You do not have permission to upload admin logos');
      }

      const data = AdminLogoUploadInput.parse(req.body);

      const ext = mime.extension(data.mimeType);
      if (!ext) throw new BadRequestError(`Invalid mime type ${data.mimeType}`);

      // Only allow image files
      if (!data.mimeType.startsWith('image/')) {
        throw new BadRequestError('Only image files are allowed for logos');
      }

      const storage = new S3Storage(Resource.appFilesBucket.name);

      const result = await withTransaction(async session => {
        // Get current logo settings
        const currentSettings = await getLogoSettings(session);

        // Determine what we're uploading
        const logoType = data.isDarkMode ? 'dark' : 'light';
        const logoTag = data.isDarkMode ? AppFileReservedTags.AdminDarkLogo : AppFileReservedTags.AdminLogo;

        // Clean up existing logo file if it exists
        const existingFileKey = data.isDarkMode ? currentSettings.customDarkLogoUrl : currentSettings.customLogoUrl;
        if (existingFileKey) {
          try {
            // If the stored value is just a filename, prepend the admin/logos/ path
            const s3KeyToDelete = existingFileKey.startsWith('admin/logos/')
              ? existingFileKey
              : `admin/logos/${existingFileKey}`;
            await storage.delete(s3KeyToDelete);
          } catch (error) {
            console.warn(`Failed to delete existing ${logoType} logo file:`, error);
          }
        }

        // Create new file key and AppFile record
        const fileKey = `custom-${logoType}-logo-${uuidv4()}.${ext}`;
        // Store the full S3 path for storage operations
        const s3Key = `admin/logos/${fileKey}`;
        // Store only the filename in the database for URL construction
        const file = new AppFile({
          userId: req.user.id,
          name: `Custom Admin ${logoType === 'dark' ? 'Dark' : 'Light'} Logo`,
          size: data.fileSize,
          path: s3Key, // Use full S3 path for the file record
          mimeType: data.mimeType,
          status: 'pending',
          tags: [logoTag],
        });

        await file.save({ session });

        // Generate presigned URL and public URL
        // ACL not needed - bucket policy grants public read for admin/logos/* prefix
        const presignedUrl = await storage.getSignedUrl(s3Key, 'put', {
          expiresIn: 600,
        });

        // Update logo settings
        const updatedSettings: Partial<LogoSettings> = {};
        if (data.isDarkMode) {
          updatedSettings.customDarkLogoUrl = fileKey;
        } else {
          updatedSettings.customLogoUrl = fileKey;
        }

        // If useBothLogos was passed, update that too
        if (data.useBothLogos !== undefined) {
          updatedSettings.useBothLogos = data.useBothLogos;
        }

        await updateLogoSettings(updatedSettings, session);

        return {
          url: presignedUrl,
          fileId: file.id,
          fileKey,
          logoUrl: `${process.env.NEXT_PUBLIC_CDN_URL}/admin-logos/${fileKey}`,
          isDarkMode: data.isDarkMode,
        };
      });

      return res.json(result);
    } catch (error) {
      console.error('Error in admin logo upload:', error);
      throw error;
    }
  })
  .delete(async (req, res) => {
    try {
      const { user } = req;

      if (!user?.isAdmin) {
        throw new ForbiddenError('You do not have permission to delete admin logos');
      }

      const { isDarkMode } = req.body;

      const result = await withTransaction(async session => {
        // Get current logo settings
        const currentSettings = await getLogoSettings(session);

        // Get the URL to delete
        const fileKey = isDarkMode ? currentSettings.customDarkLogoUrl : currentSettings.customLogoUrl;

        if (fileKey) {
          // Remove the logo from S3
          const storage = new S3Storage(Resource.appFilesBucket.name);
          // If the stored value is just a filename, prepend the admin/logos/ path
          const s3KeyToDelete = fileKey.startsWith('admin/logos/') ? fileKey : `admin/logos/${fileKey}`;
          await storage.delete(s3KeyToDelete);
        }

        // Update logo settings to remove the URL
        const updatedSettings: Partial<LogoSettings> = {};
        if (isDarkMode) {
          updatedSettings.customDarkLogoUrl = '';
        } else {
          updatedSettings.customLogoUrl = '';
        }

        await updateLogoSettings(updatedSettings, session);

        return { success: true };
      });

      return res.json(result);
    } catch (error) {
      console.error('Error in admin logo delete:', error);
      throw error;
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};

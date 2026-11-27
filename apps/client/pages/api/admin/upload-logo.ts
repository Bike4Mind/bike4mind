import {
  ApiKeyScope,
  AppFileReservedTags,
  FileGeneratePresignedUrlRequestInput,
  LogoSettings,
  settingsMap,
} from '@bike4mind/common';
import { runAfterCommit, withTransaction } from '@bike4mind/database';
import { AppFile } from '@bike4mind/database/content';
import { AdminSettings } from '@bike4mind/database/infra';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { adminApi } from '@server/middlewares/adminApi';
import { resolveBrowserAppFileUploadUrl } from '@server/utils/browserUploadUrl';
import { recordAdminSettingChange } from '@bike4mind/server-utils/utils/adminSettingsAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import mime from 'mime-types';
import { Resource } from 'sst';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'adminUploadLogo' } });

// Extended schema to support dark mode logo uploads
const AdminLogoUploadInput = FileGeneratePresignedUrlRequestInput.extend({
  isDarkMode: z.boolean().prefault(false),
  useBothLogos: z.boolean().prefault(false),
});

/** Deletes the retired logo object once the transaction commits; a failure is logged and never rolls anything back. */
function deleteLogoAfterCommit(
  session: Parameters<typeof runAfterCommit>[0],
  storage: S3Storage,
  logoType: 'light' | 'dark',
  fileKey: string
) {
  // If the stored value is just a filename, prepend the admin/logos/ path
  const key = fileKey.startsWith('admin/logos/') ? fileKey : `admin/logos/${fileKey}`;
  const run = async () => {
    try {
      await storage.delete(key);
    } catch (error) {
      logger.error(`Post-commit delete of the ${logoType} logo failed; object left orphaned`, {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (!runAfterCommit(session, `adminLogo|${logoType}`, run)) {
    logger.warn('Logo delete could not be queued after commit; running it inline', { logoType });
    void run();
  }
}

async function getLogoSettings(session?: any): Promise<LogoSettings> {
  const logoSettingsDoc = await AdminSettings.findOne({ settingName: 'logoSettings' }).session(session);

  if (logoSettingsDoc?.settingValue) {
    // Use schema from settingsMap which handles JSON string parsing via z.preprocess
    const parsed = settingsMap.logoSettings.schema.safeParse(logoSettingsDoc.settingValue);
    if (parsed.success) {
      return parsed.data;
    }
    logger.warn('Failed to parse logo settings, using defaults');
  }

  return {
    customLogoUrl: '',
    customDarkLogoUrl: '',
    useBothLogos: false,
  };
}

async function updateLogoSettings(
  newSettings: Partial<LogoSettings>,
  session?: any
): Promise<{ before: LogoSettings; after: LogoSettings }> {
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
  return { before: currentSettings, after: updatedSettings };
}

/**
 * Lambda function to generate S3 signed URL for uploading custom admin logo
 */
const handler = adminApi({
  adminPermissions: { POST: 'settings:manage', DELETE: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .post(async (req, res) => {
    try {
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
        if (existingFileKey) deleteLogoAfterCommit(session, storage, logoType, existingFileKey);

        // Create new file key and AppFile record
        const fileKey = `custom-${logoType}-logo-${crypto.randomUUID()}.${ext}`;
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
        // Bound to the declared size: the same bytes are PUT, and a longer upload is refused.
        const presignedUrl = await storage.getSignedUrl(s3Key, 'put', {
          expiresIn: 600,
          ContentLength: data.fileSize,
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

        const { before, after } = await updateLogoSettings(updatedSettings, session);
        await recordAdminSettingChange(req, {
          settingName: 'logoSettings',
          before,
          after,
          summary: `uploaded a custom ${logoType} logo`,
        });

        return {
          // Self-host swaps the (browser-unreachable) MinIO presign for the same-origin upload proxy.
          url: resolveBrowserAppFileUploadUrl(file.id, presignedUrl),
          fileId: file.id,
          fileKey,
          logoUrl: `${process.env.NEXT_PUBLIC_CDN_URL}/admin-logos/${fileKey}`,
          isDarkMode: data.isDarkMode,
        };
      });

      return res.json(result);
    } catch (error) {
      req.logger.error('Error in admin logo upload', { error });
      throw error;
    }
  })
  .delete(async (req, res) => {
    try {
      const { isDarkMode } = req.body;

      const result = await withTransaction(async session => {
        // Get current logo settings
        const currentSettings = await getLogoSettings(session);

        // Get the URL to delete
        const fileKey = isDarkMode ? currentSettings.customDarkLogoUrl : currentSettings.customLogoUrl;

        if (fileKey) {
          deleteLogoAfterCommit(
            session,
            new S3Storage(Resource.appFilesBucket.name),
            isDarkMode ? 'dark' : 'light',
            fileKey
          );
        }

        // Update logo settings to remove the URL
        const updatedSettings: Partial<LogoSettings> = {};
        if (isDarkMode) {
          updatedSettings.customDarkLogoUrl = '';
        } else {
          updatedSettings.customLogoUrl = '';
        }

        const { before, after } = await updateLogoSettings(updatedSettings, session);
        await recordAdminSettingChange(req, {
          settingName: 'logoSettings',
          before,
          after,
          summary: `removed the custom ${isDarkMode ? 'dark' : 'light'} logo`,
        });

        return { success: true };
      });

      return res.json(result);
    } catch (error) {
      req.logger.error('Error in admin logo delete', { error });
      throw error;
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};

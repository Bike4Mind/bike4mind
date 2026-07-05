import { AppFileReservedTags, FileGeneratePresignedUrlRequestInput } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { AppFile } from '@bike4mind/database/content';
import { Organization } from '@bike4mind/database/infra';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { Resource } from 'sst';

/**
 * Lambda function to generate S3 signed URL for uploading organization logo
 */
const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const orgId = req.query.id!;
    const { user } = req;

    const organization = await Organization.findById(orgId).populate('logo');
    if (!organization) throw new NotFoundError('Organization not found');

    const userInOrganization = organization.users.find(member => member.userId === user.id);

    // TODO: Restrict to only organization admins, managers or whatever role is appropriate
    if (!userInOrganization && !user.isAdmin) {
      throw new ForbiddenError('You do not have permission to upload logo for this organization');
    }

    const data = FileGeneratePresignedUrlRequestInput.parse(req.body);

    const ext = mime.extension(data.mimeType);
    if (!ext) throw new BadRequestError(`Invalid mime type ${data.mimeType}`);

    const storage = new S3Storage(Resource.appFilesBucket.name);

    const result = await withTransaction(async session => {
      if (organization.logo) {
        await storage.delete(organization.logo.path);
        await AppFile.findByIdAndDelete(organization.logo.id).session(session);
        await Organization.updateOne({ _id: orgId }, { $unset: { logoFileId: 1 } }).session(session);
      }

      const fileKey = `organizations/${orgId}/${uuidv4()}.${ext}`;

      const file = new AppFile({
        userId: req.user.id,
        name: `${organization.name} logo`,
        size: data.fileSize,
        path: fileKey,
        mimeType: data.mimeType,
        status: 'pending',
        tags: [AppFileReservedTags.OrganizationLogo],
      });

      await Promise.all([
        file.save({ session }),
        Organization.updateOne({ _id: orgId }, { logoFileId: file.id }).session(session),
      ]);

      // Note: ACL not needed - bucket policy grants public read for organizations/* prefix
      const presignedUrl = await storage.getSignedUrl(fileKey, 'put', { expiresIn: 600 });

      return { url: presignedUrl, fileId: file.id, fileKey };
    });

    return res.json(result);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

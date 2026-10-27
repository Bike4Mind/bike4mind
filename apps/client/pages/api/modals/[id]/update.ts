import { ModalModel } from '@bike4mind/database/social';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { createModalVideoSchema } from '@bike4mind/common';
import { definedKeys } from '@server/utils/adminAudit';
import { modalAuditTitle } from '@client/server/tools/modalOperations';
import { recordModalChanges } from '@client/server/tools/recordModalChanges';
import { deploymentMediaOrigins } from '@server/utils/deploymentMediaOrigins';
import { cacheExternalImage, cacheExternalImages } from '@server/utils/cacheExternalImage';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { extractVariantForViewer, viewerClassifier } from '@bike4mind/services';

const ModalVideoSchema = createModalVideoSchema({ extraOrigins: deploymentMediaOrigins() });

const ModalImageSchema = z.object({
  url: z.url(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
});

const UpdateModalRequestSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  subtitle: z.string().max(500).nullable().optional(),
  description: z.string().max(15000).nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  images: z.array(ModalImageSchema).nullable().optional(),
  video: ModalVideoSchema.nullable().optional(),
  textMessage: z.string().nullable().optional(),
  isBanner: z.coerce.boolean().optional(),
  tags: z.array(z.string()).nullable().optional(),
  priority: z.number().optional(),
  closeButton: z.coerce.boolean().optional(),
  agreeButton: z.coerce.boolean().optional(),
  enabled: z.coerce.boolean().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  numberOfAgrees: z
    .object({
      type: z.string(),
      value: z.number(),
      threshold: z.number().optional(),
      tags: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  numberOfViews: z
    .object({
      type: z.string(),
      value: z.number(),
      threshold: z.number().optional(),
      tags: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
});

const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, { id: string | string[] }>(async (req, res) => {
    const rawId = req.query?.id;
    // Handle array case (Next.js dynamic routes can return arrays)
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) throw new BadRequestError('Invalid ID');

    if (!req.ability) throw new ForbiddenError('Ability not found');
    if (!req.ability.can('update', ModalModel)) throw new ForbiddenError('Permission denied');

    const updateData = UpdateModalRequestSchema.parse(req.body);

    const modal = isValidObjectId(id) ? await ModalModel.findById(id) : null;
    if (!modal) throw new NotFoundError('Modal not found');

    if (updateData.imageUrl) {
      updateData.imageUrl = await cacheExternalImage(updateData.imageUrl);
    }

    if (updateData.images && updateData.images.length > 0) {
      updateData.images = await cacheExternalImages(updateData.images);
    }

    const before = modal.toObject() as unknown as Record<string, unknown>;
    const updatedModal = await ModalModel.findOneAndUpdate(
      { _id: id },
      { $set: updateData },
      { new: true, runValidators: true } // Return the updated modal and ensure schema validations are applied
    );

    if (!updatedModal) throw new NotFoundError('Modal not found');
    await recordModalChanges(
      req,
      [
        {
          kind: 'updated',
          id: String(updatedModal._id),
          title: modalAuditTitle(updatedModal),
          fields: definedKeys(updateData).filter(
            key => JSON.stringify(updateData[key as keyof typeof updateData]) !== JSON.stringify(before[key])
          ),
        },
      ],
      'admin-modals'
    );

    // Defense-in-depth: strip variants + generationMetadata from the response even
    // though this endpoint is admin-only today. Insulates the invariant from future
    // ability-rule changes.
    const audienceKey = await viewerClassifier.classify({ isAdmin: req.user?.isAdmin ?? false } as never);
    return res.json(extractVariantForViewer(updatedModal.toObject(), audienceKey));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { ModalModel } from '@bike4mind/database/social';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';
import { cacheExternalImage, cacheExternalImages } from '@server/utils/cacheExternalImage';

const ModalImageSchema = z.object({
  url: z.url(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
});

const CreateModalRequestSchema = z.object({
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  textMessage: z.string().nullable(),
  imageUrl: z.string().nullable(),
  images: z.array(ModalImageSchema).optional(),
  isBanner: z.boolean().prefault(false),
  description: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  priority: z.number().prefault(0),
  closeButton: z.boolean().prefault(true),
  agreeButton: z.boolean().prefault(false),
  enabled: z.boolean().prefault(true),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  // numberOfAgrees/numberOfViews mirror IndividualCounterSchema's shape
  numberOfAgrees: z
    .object({
      type: z.string(),
      value: z.number(),
      threshold: z.number().optional(),
      tags: z.array(z.string()).optional(),
    })
    .nullable(),
  numberOfViews: z
    .object({
      type: z.string(),
      value: z.number(),
      threshold: z.number().optional(),
      tags: z.array(z.string()).optional(),
    })
    .nullable(),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const newModalData = CreateModalRequestSchema.parse(req.body);

    if (!req.ability) throw new ForbiddenError('Ability not found');
    if (!req.ability.can('create', ModalModel)) throw new ForbiddenError('Permission denied');

    if (newModalData.imageUrl) {
      newModalData.imageUrl = await cacheExternalImage(newModalData.imageUrl);
    }

    if (newModalData.images && newModalData.images.length > 0) {
      newModalData.images = await cacheExternalImages(newModalData.images);
    }

    const newModal = new ModalModel(newModalData);

    await newModal.save();
    return res.status(201).send(newModal);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

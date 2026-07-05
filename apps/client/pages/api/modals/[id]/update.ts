import { ModalModel } from '@bike4mind/database/social';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { z } from 'zod';
import { cacheExternalImage, cacheExternalImages } from '@server/utils/cacheExternalImage';
import { WhatsNewDistributionService } from '@server/services/whatsNewDistribution';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';
import { Logger } from '@bike4mind/observability';
import { extractVariantForViewer, viewerClassifier, MODAL_SAFE_DEFAULT_KEY } from '@bike4mind/services';

const logger = new Logger({ metadata: { service: 'modals/update' } });

const ModalImageSchema = z.object({
  url: z.url(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
});

// Length limits match WhatsNewModalPayloadSchema in whatsNewDistribution.ts
const UpdateModalRequestSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  subtitle: z.string().max(500).nullable().optional(),
  description: z.string().max(15000).nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  images: z.array(ModalImageSchema).nullable().optional(),
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

    const modal = await ModalModel.findById(id);
    if (!modal) throw new NotFoundError('Modal not found');

    if (updateData.imageUrl) {
      updateData.imageUrl = await cacheExternalImage(updateData.imageUrl);
    }

    if (updateData.images && updateData.images.length > 0) {
      updateData.images = await cacheExternalImages(updateData.images);
    }

    const updatedModal = await ModalModel.findOneAndUpdate(
      { _id: id },
      { $set: updateData },
      { new: true, runValidators: true } // Return the updated modal and ensure schema validations are applied
    );

    // Sync to S3 distribution for What's New modals (non-critical).
    // Gate on customer-variant presence: internal-only modals have raw
    // internal text at top-level. Fork environments store the S3 payload as a
    // flat doc with no variants map, so extractVariantForViewer takes the
    // legacy-passthrough branch and would serve internal text to all fork viewers.
    const modalVariants = updatedModal?.variants;
    // Treat absent map AND empty map {} as "no customer variant" - both mean
    // no customer-facing content exists and S3 distribution must be skipped.
    const hasCustomerVariant = !modalVariants || MODAL_SAFE_DEFAULT_KEY in modalVariants;

    if (
      updatedModal?._id &&
      updatedModal.tags?.includes('whats-new') &&
      updatedModal.generationMetadata?.generatedDate &&
      hasCustomerVariant
    ) {
      const modalId = updatedModal._id.toString();
      const key = `production/${updatedModal.generationMetadata.generatedDate}.json`;
      const payload = {
        version: '1.0' as const,
        modalId,
        title: updatedModal.title || '',
        subtitle: updatedModal.subtitle || '',
        description: updatedModal.description || '',
        generatedDate: updatedModal.generationMetadata.generatedDate,
        releaseTag: updatedModal.generationMetadata.releaseTag,
        environment: 'production' as const,
        createdAt: updatedModal.createdAt?.toISOString() || new Date().toISOString(),
        metadata: {
          modelUsed: updatedModal.generationMetadata.modelUsed || 'unknown',
          correlationId: updatedModal.generationMetadata.correlationId || 'manual-edit',
          repositoryUrl: 'https://github.com/MillionOnMars/lumina5',
        },
      };
      const content = JSON.stringify(payload, null, 2);

      // Await S3 sync to prevent Lambda from freezing before the operation completes
      try {
        await WhatsNewDistributionService.updateExistingModal(modalId, key, content, updatedModal.title || '');
      } catch (error) {
        logger.warn('Failed to sync modal update to S3 distribution', {
          error: error instanceof Error ? error.message : String(error),
          modalId,
        });
        emitModalGenerationMetrics([
          { name: 'S3SyncFailure', value: 1, dimensions: { operation: 'update', modalId } },
        ]).catch(() => {});
      }
    } else if (updatedModal?._id && updatedModal.tags?.includes('whats-new') && !hasCustomerVariant) {
      logger.log('Skipping S3 distribution sync — internal-only modal has no customer content for fork environments', {
        modalId: updatedModal._id.toString(),
      });
    }

    // Defense-in-depth: strip variants + generationMetadata from the response even
    // though this endpoint is admin-only today. Insulates the invariant from future
    // ability-rule changes.
    const audienceKey = await viewerClassifier.classify({ isAdmin: req.user?.isAdmin ?? false } as never);
    return res.json(extractVariantForViewer(updatedModal?.toObject() ?? {}, audienceKey));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

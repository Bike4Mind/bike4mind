import { ModalModel } from '@bike4mind/database/social';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { WhatsNewDistributionService } from '@server/services/whatsNewDistribution';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'modals/delete' } });

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id: string | string[] }>(async (req, res) => {
    const rawId = req.query.id;
    // Handle array case (Next.js dynamic routes can return arrays)
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) throw new BadRequestError('Invalid ID');

    if (!req.ability) throw new ForbiddenError('Ability not found');
    if (!req.ability.can('delete', ModalModel)) throw new ForbiddenError('Permission denied');

    // Capture metadata before delete for S3 sync
    const modal = await ModalModel.findById(id);
    if (!modal) throw new NotFoundError('Modal not found');

    const isWhatsNewModal = modal.tags?.includes('whats-new');
    const generatedDate = modal.generationMetadata?.generatedDate;

    const deletedModal = await ModalModel.findOneAndDelete({ _id: id });
    if (!deletedModal) throw new NotFoundError('Modal not found');

    // Sync deletion to S3 distribution for What's New modals (non-critical)
    // Must await to prevent Lambda from freezing before the operation completes
    if (isWhatsNewModal && generatedDate) {
      const key = `production/${generatedDate}.json`;

      try {
        await WhatsNewDistributionService.deleteModal(id, key);
      } catch (error) {
        logger.warn('Failed to sync modal deletion to S3 distribution', {
          error: error instanceof Error ? error.message : String(error),
          modalId: id,
        });
        emitModalGenerationMetrics([
          { name: 'S3SyncFailure', value: 1, dimensions: { operation: 'delete', modalId: id } },
        ]).catch(() => {});
      }
    }

    return res.status(200).json(deletedModal);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

/**
 * Lattice Model Hydration API
 *
 * POST /api/lattice/models/[id]/hydrate - Compute all derived values
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { latticeModelService } from '@bike4mind/services';
import { latticeModelRepository } from '@bike4mind/database';
import { NotFoundError, BadRequestError } from '@server/utils/errors';

const handler = baseApi({ auth: true }).post(
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { id } = req.query as { id?: string };
    const { scenarioId } = req.body as { scenarioId?: string };

    if (!id) {
      throw new BadRequestError('Model ID is required');
    }

    try {
      const result = await latticeModelService.hydrateModel(
        { id: user.id, organizationId: user.organizationId || undefined },
        id,
        { db: { latticeModels: latticeModelRepository } },
        { scenarioId }
      );

      return res.json({
        success: true,
        computedValues: result.computedValues,
        errors: result.errors,
        computedAt: result.computedAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Model not found') {
        throw new NotFoundError('Model not found');
      }
      throw error;
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

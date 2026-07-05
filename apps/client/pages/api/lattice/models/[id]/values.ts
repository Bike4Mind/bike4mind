/**
 * Lattice Model Values API
 *
 * PUT /api/lattice/models/[id]/values - Set a value on an entity
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { latticeModelService } from '@bike4mind/services';
import { latticeModelRepository } from '@bike4mind/database';
import { NotFoundError, BadRequestError } from '@server/utils/errors';
import type { PrimitiveValue } from '@bike4mind/common';

const handler = baseApi({ auth: true }).put(
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { id: modelId } = req.query as { id?: string };
    const { entityId, attributeKey, value } = req.body as {
      entityId: string;
      attributeKey: string;
      value: PrimitiveValue;
    };

    if (!modelId) {
      throw new BadRequestError('Model ID is required');
    }

    if (!entityId || !attributeKey) {
      throw new BadRequestError('Entity ID and attribute key are required');
    }

    try {
      const model = await latticeModelService.setValue(
        { id: user.id, organizationId: user.organizationId || undefined },
        modelId,
        entityId,
        attributeKey,
        value,
        { db: { latticeModels: latticeModelRepository } }
      );

      if (!model) {
        throw new NotFoundError('Model not found');
      }

      return res.json(model);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw new NotFoundError(error.message);
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

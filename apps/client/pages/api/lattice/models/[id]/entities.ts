/**
 * Lattice Model Entities API
 *
 * POST /api/lattice/models/[id]/entities - Add an entity to the model
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { latticeModelService } from '@bike4mind/services';
import { latticeModelRepository } from '@bike4mind/database';
import { NotFoundError, BadRequestError } from '@server/utils/errors';
import type { LatticeEntityType, LatticeDataType } from '@bike4mind/common';

const handler = baseApi({ auth: true }).post(
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { id: modelId } = req.query as { id?: string };
    const {
      entityId,
      name,
      type,
      displayName,
      attributes = [],
      metadata = {},
    } = req.body as {
      entityId: string;
      name: string;
      type: LatticeEntityType;
      displayName?: string;
      attributes?: Array<{
        key: string;
        value: number | string | boolean | null;
        dataType?: LatticeDataType;
      }>;
      metadata?: Record<string, unknown>;
    };

    if (!modelId) {
      throw new BadRequestError('Model ID is required');
    }

    if (!entityId || !name || !type) {
      throw new BadRequestError('Entity ID, name, and type are required');
    }

    try {
      const model = await latticeModelService.addEntity(
        { id: user.id, organizationId: user.organizationId || undefined },
        modelId,
        {
          id: entityId,
          name,
          type,
          displayName,
          attributes: attributes.map(attr => ({
            key: attr.key,
            value: attr.value,
            dataType: attr.dataType || (typeof attr.value === 'number' ? 'number' : 'string'),
            isComputed: false,
          })),
          metadata,
        },
        { db: { latticeModels: latticeModelRepository } }
      );

      if (!model) {
        throw new NotFoundError('Model not found');
      }

      return res.status(201).json(model);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        throw new BadRequestError(error.message);
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

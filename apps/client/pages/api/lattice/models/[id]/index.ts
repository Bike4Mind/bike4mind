/**
 * Lattice Model API - Get, Update, Delete
 *
 * GET /api/lattice/models/[id] - Get a model by ID
 * PUT /api/lattice/models/[id] - Update a model
 * DELETE /api/lattice/models/[id] - Delete a model (soft delete)
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { latticeModelService } from '@bike4mind/services';
import { latticeModelRepository } from '@bike4mind/database';
import { NotFoundError, BadRequestError } from '@server/utils/errors';

const handler = baseApi({ auth: true })
  .get(
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const { id } = req.query as { id?: string };

      if (!id) {
        throw new BadRequestError('Model ID is required');
      }

      const model = await latticeModelService.getModel(
        { id: user.id, organizationId: user.organizationId || undefined },
        id,
        { db: { latticeModels: latticeModelRepository } }
      );

      if (!model) {
        throw new NotFoundError('Model not found');
      }

      return res.json(model);
    })
  )
  .put(
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const { id } = req.query as { id?: string };
      const { name, description, settings } = req.body as {
        name?: string;
        description?: string;
        settings?: Record<string, unknown>;
      };

      if (!id) {
        throw new BadRequestError('Model ID is required');
      }

      const model = await latticeModelService.updateModel(
        { id: user.id, organizationId: user.organizationId || undefined },
        id,
        { name, description, settings: settings as any },
        { db: { latticeModels: latticeModelRepository } }
      );

      if (!model) {
        throw new NotFoundError('Model not found');
      }

      return res.json(model);
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const { id } = req.query as { id?: string };

      if (!id) {
        throw new BadRequestError('Model ID is required');
      }

      const deleted = await latticeModelService.deleteModel(
        { id: user.id, organizationId: user.organizationId || undefined },
        id,
        { db: { latticeModels: latticeModelRepository } }
      );

      if (!deleted) {
        throw new NotFoundError('Model not found');
      }

      return res.json({ success: true, message: 'Model deleted' });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

/**
 * Lattice Models API - List and Create
 *
 * GET /api/lattice/models - List user's models
 * POST /api/lattice/models - Create a new model
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { latticeModelService } from '@bike4mind/services';
import { latticeModelRepository } from '@bike4mind/database';
import { LatticeModelTypeSchema } from '@bike4mind/common';

const handler = baseApi({ auth: true })
  .get(
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const { limit, skip, sessionId, projectId } = req.query as {
        limit?: string;
        skip?: string;
        sessionId?: string;
        projectId?: string;
      };

      const result = await latticeModelService.listModels(
        { id: user.id, organizationId: user.organizationId || undefined },
        {
          limit: limit ? parseInt(limit, 10) : 20,
          skip: skip ? parseInt(skip, 10) : 0,
          sessionId,
          projectId,
        },
        { db: { latticeModels: latticeModelRepository } }
      );

      return res.json({
        data: result.models,
        meta: {
          total: result.total,
          limit: limit ? parseInt(limit, 10) : 20,
          skip: skip ? parseInt(skip, 10) : 0,
        },
      });
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const { name, description, modelType, sessionId, projectId } = req.body as {
        name: string;
        description?: string;
        modelType?: string;
        sessionId?: string;
        projectId?: string;
      };

      if (!name) {
        return res.status(400).json({ error: 'Model name is required' });
      }

      const parsedModelType = modelType ? LatticeModelTypeSchema.safeParse(modelType) : undefined;
      if (modelType && (!parsedModelType || !parsedModelType.success)) {
        return res.status(400).json({ error: `Invalid modelType: "${modelType}"` });
      }

      const model = await latticeModelService.createModel(
        { id: user.id, organizationId: user.organizationId || undefined },
        { name, description, modelType: parsedModelType?.data, sessionId, projectId },
        { db: { latticeModels: latticeModelRepository } }
      );

      return res.status(201).json(model);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

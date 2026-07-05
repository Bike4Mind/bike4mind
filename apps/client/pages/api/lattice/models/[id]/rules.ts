/**
 * Lattice Model Rules API
 *
 * POST /api/lattice/models/[id]/rules - Add a rule to the model
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { latticeModelService } from '@bike4mind/services';
import { latticeModelRepository } from '@bike4mind/database';
import { NotFoundError, BadRequestError } from '@server/utils/errors';
import type { LatticeRuleType, ILatticeRuleDefinition } from '@bike4mind/common';

const handler = baseApi({ auth: true }).post(
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { id: modelId } = req.query as { id?: string };
    const {
      ruleId,
      name,
      type,
      description,
      definition,
      dependencies = [],
      priority = 0,
      enabled = true,
    } = req.body as {
      ruleId: string;
      name: string;
      type: LatticeRuleType;
      description?: string;
      definition: ILatticeRuleDefinition;
      dependencies?: string[];
      priority?: number;
      enabled?: boolean;
    };

    if (!modelId) {
      throw new BadRequestError('Model ID is required');
    }

    if (!ruleId || !name || !type || !definition) {
      throw new BadRequestError('Rule ID, name, type, and definition are required');
    }

    try {
      const model = await latticeModelService.addRule(
        { id: user.id, organizationId: user.organizationId || undefined },
        modelId,
        {
          id: ruleId,
          name,
          type,
          description,
          definition,
          dependencies,
          priority,
          enabled,
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

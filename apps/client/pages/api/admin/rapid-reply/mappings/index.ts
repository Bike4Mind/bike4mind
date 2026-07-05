import { rapidReplyMappingRepository } from '@bike4mind/database/ai';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { RapidReplyResponseStyleCommon } from '@bike4mind/common';

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const mappings = await rapidReplyMappingRepository.findAll();
    return res.json({ mappings });
  })
  .post(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const {
      mainModelId,
      rapidModelId,
      enabled = true,
      priority = 1,
      systemPrompt,
      maxTokens = 150,
      responseStyle = 'auto',
      maxLatency = 2000,
    } = req.body as {
      mainModelId: string;
      rapidModelId: string;
      enabled?: boolean;
      priority?: number;
      systemPrompt: string;
      maxTokens?: number;
      responseStyle?: RapidReplyResponseStyleCommon;
      maxLatency?: number;
    };

    if (!mainModelId || !rapidModelId || !systemPrompt) {
      throw new BadRequestError('mainModelId, rapidModelId, and systemPrompt are required');
    }

    // Check if mapping already exists for this main model
    const existingMapping = await rapidReplyMappingRepository.findByMainModel(mainModelId);
    if (existingMapping) {
      throw new BadRequestError('A mapping already exists for this main model');
    }

    const newMapping = await rapidReplyMappingRepository.createMapping({
      mainModelId,
      rapidModelId,
      enabled,
      priority,
      systemPrompt,
      maxTokens,
      responseStyle,
      maxLatency,
      createdBy: req.user!.id,
      usageCount: 0,
    });

    await rapidReplyAuditLogRepository.createLog({
      entityType: 'mapping',
      entityId: newMapping.id,
      action: 'create',
      changes: {
        mapping: { after: newMapping },
      },
      userId: req.user!.id,
      userEmail: req.user!.email || undefined,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.status(201).json(newMapping);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

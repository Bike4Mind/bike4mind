import { rapidReplyPromptRepository } from '@bike4mind/database/ai';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { active, domains, modelPairId } = req.query as {
      active?: string;
      domains?: string;
      modelPairId?: string;
    };

    let prompts;

    if (active === 'true') {
      prompts = await rapidReplyPromptRepository.findActive();
    } else if (domains && typeof domains === 'string') {
      const domainArray = domains.split(',').map(d => d.trim());
      prompts = await rapidReplyPromptRepository.findByDomains(domainArray);
    } else if (modelPairId && typeof modelPairId === 'string') {
      prompts = await rapidReplyPromptRepository.findByModelPair(modelPairId);
    } else {
      prompts = await rapidReplyPromptRepository.findAll();
    }

    return res.json(prompts);
  })
  .post(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const {
      name,
      description,
      content,
      modelPairIds = [],
      domains = [],
      isActive = true,
      parameters,
      variables,
    } = req.body as {
      name: string;
      description?: string;
      content: string;
      modelPairIds?: string[];
      domains?: string[];
      isActive?: boolean;
      parameters?: any;
      variables?: any;
    };

    if (!name || !content) {
      throw new BadRequestError('Name and content are required');
    }

    const newPrompt = await rapidReplyPromptRepository.createPrompt({
      name,
      description,
      content,
      modelPairIds,
      domains,
      isActive,
      parameters,
      variables,
      createdBy: req.user!.id,
      usageCount: 0,
      version: 1,
    });

    await rapidReplyAuditLogRepository.createLog({
      entityType: 'prompt',
      entityId: newPrompt.id,
      action: 'create',
      changes: {
        prompt: { after: newPrompt },
      },
      userId: req.user!.id,
      userEmail: req.user!.email || undefined,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.status(201).json(newPrompt);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

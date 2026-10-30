import { rapidReplyPromptRepository } from '@bike4mind/database/ai';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const handler = adminApi({
  adminPermissions: { GET: 'support:read', POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .get(async (req, res) => {
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

    await recordAdminActionFromRequest(req, {
      action: 'settings.rapid_reply_prompt.created',
      target: { kind: 'settings', id: newPrompt.id, displayName: `Rapid reply prompt ${newPrompt.name}` },
      summary: `created rapid reply prompt ${newPrompt.name}`,
      details: { name: newPrompt.name, isActive: newPrompt.isActive },
    });

    return res.status(201).json(newPrompt);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

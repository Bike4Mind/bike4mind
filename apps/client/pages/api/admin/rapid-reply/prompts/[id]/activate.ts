import { rapidReplyPromptRepository } from '@bike4mind/database/ai';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, ForbiddenError } from '@server/utils/errors';

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };

  if (!id || typeof id !== 'string') {
    throw new BadRequestError('Prompt ID is required');
  }

  // Get current prompt for audit log
  const currentPrompt = await rapidReplyPromptRepository.findById(id);
  if (!currentPrompt) {
    throw new NotFoundError('Rapid reply prompt not found');
  }

  const success = await rapidReplyPromptRepository.activateVersion(id);

  if (!success) {
    throw new NotFoundError('Failed to activate prompt version');
  }

  const updatedPrompt = await rapidReplyPromptRepository.findById(id);

  await rapidReplyAuditLogRepository.createLog({
    entityType: 'prompt',
    entityId: id,
    action: 'activate',
    changes: {
      isActive: { before: currentPrompt.isActive, after: true },
      activated: { after: true },
    },
    userId: req.user!.id,
    userEmail: req.user!.email || undefined,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    metadata: {
      parentId: currentPrompt.parentId || currentPrompt.id,
      version: currentPrompt.version,
    },
  });

  return res.json({
    success: true,
    message: 'Prompt version activated successfully',
    prompt: updatedPrompt,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

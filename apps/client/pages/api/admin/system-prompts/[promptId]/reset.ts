import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { systemPromptRepository } from '@bike4mind/database';
import { getDefaultSystemPrompts } from '@server/utils/systemPrompts/defaults';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  /**
   * POST /api/admin/system-prompts/[promptId]/reset
   * Reset a system prompt to its code default
   * Deletes the DB override and preserves the final version in history.
   */
  async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { promptId } = req.query as { promptId: string };

    if (typeof promptId !== 'string') {
      return res.status(400).json({
        error: 'Invalid promptId',
        message: 'promptId must be a string',
      });
    }

    const defaultPrompts = getDefaultSystemPrompts();
    const defaultPrompt = defaultPrompts.find(p => p.promptId === promptId);

    if (!defaultPrompt) {
      return res.status(400).json({
        error: 'Cannot reset',
        message: 'This prompt has no code default to reset to. You can only reset prompts that have a code default.',
      });
    }

    const dbPrompt = await systemPromptRepository.findByPromptId(promptId);

    if (!dbPrompt) {
      return res.status(400).json({
        error: 'Already at default',
        message: 'This prompt is already using the code default. No override to remove.',
      });
    }

    const result = await systemPromptRepository.resetToDefault(
      promptId,
      req.user?.id || 'system',
      req.user?.name || 'Admin'
    );

    if (!result.deleted) {
      return res.status(500).json({
        error: 'Reset failed',
        message: 'Failed to delete the database override.',
      });
    }

    await recordAdminActionFromRequest(req, {
      action: 'settings.system_prompt.reset',
      target: { kind: 'settings', id: promptId, displayName: defaultPrompt.name },
      summary: `reset system prompt ${promptId} to code default`,
      details: { previousVersion: dbPrompt.version, historyPreserved: result.historyPreserved },
    });

    return res.status(200).json({
      success: true,
      message: `System prompt "${defaultPrompt.name}" has been reset to code default. Override v${dbPrompt.version} preserved in history.`,
      data: {
        promptId,
        previousVersion: dbPrompt.version,
        historyPreserved: result.historyPreserved,
        defaultPrompt: {
          ...defaultPrompt,
          hasOverride: false,
          source: 'code' as const,
        },
      },
    });
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

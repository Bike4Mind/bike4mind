import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { systemPromptRepository } from '@bike4mind/database';
import { getDefaultSystemPrompts } from '@server/utils/systemPrompts/defaults';

const handler = baseApi().post(
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

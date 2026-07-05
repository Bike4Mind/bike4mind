import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { systemPromptRepository, systemPromptHistoryRepository } from '@bike4mind/database';
import { getDefaultSystemPrompts } from '@server/utils/systemPrompts/defaults';

const handler = baseApi().get(
  /**
   * GET /api/admin/system-prompts/[promptId]/history
   * Get version history for a system prompt
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

    let history = await systemPromptHistoryRepository.getVersions(promptId);

    const dbPrompt = await systemPromptRepository.findByPromptId(promptId);

    if (dbPrompt) {
      // Lazy seed history if none exists
      if (history.length === 0) {
        try {
          await systemPromptHistoryRepository.saveVersion({
            promptId: dbPrompt.promptId,
            version: dbPrompt.version,
            content: dbPrompt.content,
            name: dbPrompt.name,
            description: dbPrompt.description,
            category: dbPrompt.category,
            tags: dbPrompt.tags,
            variables: dbPrompt.variables,
            changeReason: 'Initial version (baseline)',
            createdBy: dbPrompt.lastUpdatedBy,
            createdByName: dbPrompt.lastUpdatedByName,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : '';
          const isDuplicateKey = message.toLowerCase().includes('duplicate key') || message.includes('E11000');
          if (!isDuplicateKey) {
            throw err;
          }
        }
        history = await systemPromptHistoryRepository.getVersions(promptId);
      }

      // Lazy migrate activeVersion if not set
      if (dbPrompt.activeVersion === undefined || dbPrompt.activeVersion === null) {
        await systemPromptRepository.updateActiveVersion(dbPrompt.promptId, dbPrompt.version);
      }
    }

    const defaultPrompts = getDefaultSystemPrompts();
    const defaultPrompt = defaultPrompts.find(p => p.promptId === promptId);

    return res.status(200).json({
      success: true,
      data: {
        promptId,
        currentVersion: dbPrompt?.version ?? null,
        hasOverride: !!dbPrompt,
        hasDefault: !!defaultPrompt,
        defaultPrompt: defaultPrompt || null,
        history,
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

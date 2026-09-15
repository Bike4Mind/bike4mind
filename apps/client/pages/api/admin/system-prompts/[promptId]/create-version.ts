import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { systemPromptRepository } from '@bike4mind/database';

const handler = baseApi().post(
  /**
   * POST /api/admin/system-prompts/[promptId]/create-version
   * Create a new version of the prompt
   */
  async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { promptId } = req.query as { promptId: string };
    const {
      content,
      name,
      description,
      category,
      tags,
      variables,
      enabled,
      setAsActive = true,
    } = req.body as {
      content: string;
      name: string;
      description: string;
      category: string;
      tags: string[];
      variables: string[];
      enabled?: boolean;
      setAsActive?: boolean;
    };

    if (typeof promptId !== 'string') {
      return res.status(400).json({
        error: 'Invalid promptId',
        message: 'promptId must be a string',
      });
    }

    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({
        error: 'Invalid content',
        message: 'content is required',
      });
    }

    const prompt = await systemPromptRepository.findByPromptId(promptId);
    if (!prompt) {
      return res.status(404).json({
        error: 'Not found',
        message: 'System prompt not found',
      });
    }

    // Lazy migrate activeVersion for legacy prompts
    const needsMigration = prompt.activeVersion === undefined || prompt.activeVersion === null;
    if (needsMigration) {
      const currentVersion = prompt.version || 1;
      await systemPromptRepository.updateActiveVersion(promptId, currentVersion);
    }

    const result = await systemPromptRepository.createNewVersion(
      promptId,
      { content, name, description, category, tags, variables },
      req.user?.id || 'system',
      req.user?.name || 'Admin',
      setAsActive
    );

    if (typeof enabled === 'boolean') {
      await systemPromptRepository.toggleEnabled(promptId, enabled);
    }

    return res.status(200).json({
      success: true,
      message: `Created version ${result.version}${setAsActive ? ' and set as active' : ''}`,
      data: {
        version: result.version,
        history: result.history,
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

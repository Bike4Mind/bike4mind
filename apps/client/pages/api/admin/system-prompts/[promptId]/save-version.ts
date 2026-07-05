import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { systemPromptRepository } from '@bike4mind/database';

const handler = baseApi().post(
  /**
   * POST /api/admin/system-prompts/[promptId]/save-version
   * Save changes to a specific version (update in place)
   */
  async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { promptId } = req.query as { promptId: string };
    const { version, content, name, description, category, tags, variables, enabled } = req.body as {
      version: number;
      content: string;
      name?: string;
      description?: string;
      category?: string;
      tags?: string[];
      variables?: string[];
      enabled?: boolean;
    };

    if (typeof promptId !== 'string') {
      return res.status(400).json({
        error: 'Invalid promptId',
        message: 'promptId must be a string',
      });
    }

    if (typeof version !== 'number') {
      return res.status(400).json({
        error: 'Invalid version',
        message: 'version must be a number',
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

    const updated = await systemPromptRepository.saveToVersion(
      promptId,
      version,
      { content, name, description, category, tags, variables },
      req.user?.id || 'system',
      req.user?.name || 'Admin'
    );

    if (!updated) {
      return res.status(404).json({
        error: 'Version not found',
        message: `Version ${version} not found in history`,
      });
    }

    if (typeof enabled === 'boolean') {
      await systemPromptRepository.toggleEnabled(promptId, enabled);
    }

    return res.status(200).json({
      success: true,
      message: `Saved changes to version ${version}`,
      data: updated,
    });
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

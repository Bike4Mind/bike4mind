import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { systemPromptRepository } from '@bike4mind/database';
import { getDefaultSystemPrompts } from '@server/utils/systemPrompts/defaults';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  /**
   * POST /api/admin/system-prompts/[promptId]/switch-version
   * Switch the active version for a system prompt
   * Body: { targetVersion: number } (0 = code default, 1+ = stored version)
   */
  async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { promptId } = req.query as { promptId: string };
    const { targetVersion } = req.body as { targetVersion: number };

    if (typeof promptId !== 'string') {
      return res.status(400).json({
        error: 'Invalid promptId',
        message: 'promptId must be a string',
      });
    }

    if (typeof targetVersion !== 'number' || targetVersion < 0) {
      return res.status(400).json({
        error: 'Invalid targetVersion',
        message: 'targetVersion must be a number (0 = default, 1+ = stored version)',
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

    // Get code default content if switching to default (0)
    let codeDefaultContent: string | undefined;
    if (targetVersion === 0) {
      const defaults = getDefaultSystemPrompts();
      const defaultPrompt = defaults.find(p => p.promptId === promptId);
      if (!defaultPrompt) {
        return res.status(400).json({
          error: 'No code default',
          message: `Cannot switch to default: no code default exists for prompt "${promptId}"`,
        });
      }
      codeDefaultContent = defaultPrompt.content;
    }

    const updated = await systemPromptRepository.switchVersion(
      promptId,
      targetVersion,
      req.user?.id || 'system',
      req.user?.name || 'Admin',
      codeDefaultContent
    );

    await recordAdminActionFromRequest(req, {
      action: 'settings.system_prompt.version_switched',
      target: { kind: 'settings', id: promptId, displayName: prompt.name },
      summary: `switched system prompt ${promptId} to ${targetVersion === 0 ? 'code default' : `version ${targetVersion}`}`,
      changes: [{ field: 'activeVersion', before: prompt.activeVersion ?? prompt.version ?? 1, after: targetVersion }],
    });

    return res.status(200).json({
      success: true,
      message: `Switched to ${targetVersion === 0 ? 'default' : `version ${targetVersion}`}`,
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

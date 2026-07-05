import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { systemPromptRepository } from '@bike4mind/database';
import { getDefaultSystemPrompts } from '@server/utils/systemPrompts/defaults';
import { z } from 'zod';

const UpdateSystemPromptSchema = z.object({
  name: z.string().min(3).max(200).optional(),
  description: z.string().min(10).max(2000).optional(),
  content: z.string().min(50).max(50000),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  variables: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

const handler = baseApi()
  .get(
    /**
     * GET /api/admin/system-prompts/[promptId]
     * Get a single system prompt by promptId
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

      // Check DB first
      const dbPrompt = await systemPromptRepository.findByPromptId(promptId);

      if (dbPrompt) {
        return res.status(200).json({
          success: true,
          data: {
            ...dbPrompt,
            hasOverride: true,
            source: 'db' as const,
          },
        });
      }

      // Check defaults
      const defaultPrompts = getDefaultSystemPrompts();
      const defaultPrompt = defaultPrompts.find(p => p.promptId === promptId);

      if (defaultPrompt) {
        return res.status(200).json({
          success: true,
          data: {
            ...defaultPrompt,
            hasOverride: false,
            source: 'code' as const,
          },
        });
      }

      return res.status(404).json({
        error: 'Prompt not found',
        message: `System prompt with ID "${promptId}" not found`,
      });
    }
  )
  .put(
    /**
     * PUT /api/admin/system-prompts/[promptId]
     * Create or update a system prompt
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

      const validated = UpdateSystemPromptSchema.parse(req.body);

      const existing = await systemPromptRepository.findByPromptId(promptId);
      const defaultPrompts = getDefaultSystemPrompts();
      const defaultPrompt = defaultPrompts.find(p => p.promptId === promptId);

      if (existing) {
        const updated = await systemPromptRepository.updatePrompt(
          promptId,
          {
            name: validated.name,
            description: validated.description,
            content: validated.content,
            category: validated.category,
            tags: validated.tags,
            variables: validated.variables,
          },
          req.user?.id || 'system',
          req.user?.name || 'Admin'
        );

        if (validated.enabled !== undefined && validated.enabled !== updated?.enabled) {
          await systemPromptRepository.toggleEnabled(promptId, validated.enabled);
        }

        const final = await systemPromptRepository.findByPromptId(promptId);

        return res.status(200).json({
          success: true,
          data: {
            ...final,
            hasOverride: true,
            source: 'db' as const,
          },
          message: `System prompt "${final?.name}" updated successfully (v${final?.version})`,
        });
      } else {
        const newPrompt = await systemPromptRepository.upsertPrompt({
          promptId,
          name: validated.name || defaultPrompt?.name || promptId,
          description: validated.description || defaultPrompt?.description || '',
          content: validated.content,
          category: validated.category || defaultPrompt?.category || 'system',
          tags: validated.tags || defaultPrompt?.tags || [],
          variables: validated.variables || defaultPrompt?.variables || [],
          enabled: validated.enabled ?? true,
          createdBy: req.user?.id || 'system',
          lastUpdatedBy: req.user?.id || 'system',
          lastUpdatedByName: req.user?.name || 'Admin',
        });

        return res.status(201).json({
          success: true,
          data: {
            ...newPrompt,
            hasOverride: true,
            source: 'db' as const,
          },
          message: `System prompt "${newPrompt.name}" created successfully (v${newPrompt.version})`,
        });
      }
    }
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

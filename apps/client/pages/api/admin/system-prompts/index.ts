import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { systemPromptRepository } from '@bike4mind/database';
import { getDefaultSystemPrompts } from '@server/utils/systemPrompts/defaults';
import { z } from 'zod';

const GetSystemPromptsQuerySchema = z.object({
  category: z.string().optional(),
  enabled: z.enum(['true', 'false', 'all']).optional().default('all'),
  search: z.string().optional(),
  source: z.enum(['code', 'db', 'all']).optional().default('all'),
});

const CreateSystemPromptSchema = z.object({
  promptId: z.string().min(1, 'Prompt ID is required'),
  name: z.string().min(1, 'Name is required'),
  description: z.string().min(1, 'Description is required'),
  content: z.string().min(1, 'Content is required'),
  category: z.string().min(1, 'Category is required'),
  tags: z.array(z.string()).default([]),
  variables: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const handler = baseApi()
  .get(
    /**
     * GET /api/admin/system-prompts
     * Get all system prompts with optional filtering.
     * Returns both code-defined defaults and database overrides.
     */
    async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { category, enabled, search, source } = GetSystemPromptsQuerySchema.parse(req.query);

      // Load default prompts from code
      const defaultPrompts = getDefaultSystemPrompts();

      // Load all DB overrides
      const dbPrompts = await systemPromptRepository.find({});
      const dbPromptsByPromptId = new Map(dbPrompts.map(p => [p.promptId, p]));

      // Merge: For each default prompt, check if DB override exists
      const allPrompts = await Promise.all(
        defaultPrompts.map(async defaultPrompt => {
          const dbOverride = dbPromptsByPromptId.get(defaultPrompt.promptId);

          if (dbOverride) {
            // Flag a stale override: when the content the app actually serves no longer
            // matches the current code default, the override has drifted (the code default
            // moved on since it was authored). Resolve the active content WITHOUT a re-query
            // in the common cases (we already hold the doc); only the rare historical-active
            // version needs getActiveContent's history lookup.
            const av = dbOverride.activeVersion;
            let activeContent: string | null;
            if (av === 0) {
              // App uses the code default: by definition not diverged.
              activeContent = defaultPrompt.content;
            } else if (av === undefined || av === null || av === dbOverride.version) {
              // Legacy (no activeVersion) or the latest stored version is active; both serve
              // the override's own top-level content.
              activeContent = dbOverride.content;
            } else {
              // A historical version is active: resolve its content from history.
              activeContent = await systemPromptRepository.getActiveContent(defaultPrompt.promptId, {
                content: defaultPrompt.content,
              });
            }
            return {
              ...dbOverride,
              hasOverride: true,
              source: 'db' as const,
              divergesFromCodeDefault: activeContent !== defaultPrompt.content,
            };
          } else {
            return {
              ...defaultPrompt,
              hasOverride: false,
              source: 'code' as const,
              divergesFromCodeDefault: false,
            };
          }
        })
      );

      // Also include DB-only prompts (not in defaults): no code default to diverge from.
      for (const [promptId, dbPrompt] of Array.from(dbPromptsByPromptId.entries())) {
        if (!defaultPrompts.find(p => p.promptId === promptId)) {
          allPrompts.push({
            ...dbPrompt,
            hasOverride: true,
            source: 'db' as const,
            divergesFromCodeDefault: false,
          });
        }
      }

      // Apply filters
      let filteredPrompts = allPrompts;

      if (source !== 'all') {
        filteredPrompts = filteredPrompts.filter(p => p.source === source);
      }

      if (category) {
        filteredPrompts = filteredPrompts.filter(p => p.category === category);
      }

      if (enabled !== 'all') {
        const isEnabled = enabled === 'true';
        filteredPrompts = filteredPrompts.filter(p => p.enabled === isEnabled);
      }

      if (search) {
        const searchLower = search.toLowerCase();
        filteredPrompts = filteredPrompts.filter(
          p =>
            p.name.toLowerCase().includes(searchLower) ||
            p.description.toLowerCase().includes(searchLower) ||
            p.content.toLowerCase().includes(searchLower) ||
            p.tags.some(tag => tag.toLowerCase().includes(searchLower))
        );
      }

      filteredPrompts.sort((a, b) => {
        if (a.category !== b.category) {
          return a.category.localeCompare(b.category);
        }
        return a.name.localeCompare(b.name);
      });

      return res.status(200).json({
        success: true,
        data: filteredPrompts,
        count: filteredPrompts.length,
      });
    }
  )
  .post(
    /**
     * POST /api/admin/system-prompts
     * Create a new system prompt
     */
    async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const promptData = CreateSystemPromptSchema.parse(req.body);

      const existing = await systemPromptRepository.findOne({ promptId: promptData.promptId });
      if (existing) {
        return res.status(409).json({
          success: false,
          error: `Prompt ID "${promptData.promptId}" already exists`,
        });
      }

      const newPrompt = await systemPromptRepository.create({
        ...promptData,
        version: 1,
        activeVersion: 1,
        usageCount: 0,
        successCount: 0,
        errorCount: 0,
        lastUsedAt: null,
        createdBy: req.user?.email || 'system',
        lastUpdatedBy: req.user?.email || 'system',
        lastUpdatedByName: req.user?.name || 'System',
      });

      return res.status(201).json({
        success: true,
        data: newPrompt,
        message: 'System prompt created successfully',
      });
    }
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

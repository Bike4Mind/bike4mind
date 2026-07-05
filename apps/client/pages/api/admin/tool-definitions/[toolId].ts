import { toolDefinitionOverrideRepository } from '@bike4mind/database';
import { B4MLLMToolsList, MCP_PROVIDER_METADATA } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, ForbiddenError } from '@server/utils/errors';
import { TOOL_MAPPING, TOOL_CATEGORIES } from '@client/app/utils/toolMapping';
import { z } from 'zod';

// Validation schema for updates
const updateSchema = z.object({
  description: z
    .string()
    .min(50, 'Description must be at least 50 characters')
    .max(10000, 'Description must not exceed 10,000 characters'),
  shortDescription: z
    .string()
    .min(10, 'Short description must be at least 10 characters')
    .max(500, 'Short description must not exceed 500 characters'),
  enabled: z.boolean().optional(),
});

// Find tool in code
function findCodeTool(toolId: string): { toolName: string; description: string; category: string } | null {
  // Check built-in LLM tools
  if (B4MLLMToolsList.includes(toolId as (typeof B4MLLMToolsList)[number])) {
    const mappingInfo = TOOL_MAPPING[toolId as keyof typeof TOOL_MAPPING];
    const description = mappingInfo?.description || `${toolId} tool`;
    const displayName = mappingInfo?.displayName || toolId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    return {
      toolName: displayName,
      description,
      category: TOOL_CATEGORIES[toolId] || 'Utility',
    };
  }

  // Check MCP provider tools
  for (const [providerName, metadata] of Object.entries(MCP_PROVIDER_METADATA)) {
    if (metadata.defaultToolDescriptions) {
      // Check if toolId matches provider_toolname format
      const prefix = `${providerName}_`;
      if (toolId.startsWith(prefix)) {
        const mcpToolId = toolId.substring(prefix.length);
        const description = metadata.defaultToolDescriptions[mcpToolId];
        if (description) {
          return {
            toolName: mcpToolId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            description,
            category: `MCP: ${providerName.charAt(0).toUpperCase() + providerName.slice(1)}`,
          };
        }
      }
    }
  }

  return null;
}

const handler = baseApi()
  .get(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { toolId } = req.query;

      if (!toolId || typeof toolId !== 'string') {
        throw new BadRequestError('Tool ID is required');
      }

      // First check database for override
      const dbOverride = await toolDefinitionOverrideRepository.findByToolId(toolId);

      if (dbOverride) {
        return res.json({
          toolId: dbOverride.toolId,
          toolName: dbOverride.toolName,
          description: dbOverride.description,
          shortDescription: dbOverride.shortDescription,
          category: dbOverride.category,
          tags: dbOverride.tags,
          parameters: dbOverride.parameters,
          enabled: dbOverride.enabled,
          version: dbOverride.version,
          source: 'database',
          hasOverride: true,
          usageCount: dbOverride.usageCount,
          successCount: dbOverride.successCount,
          errorCount: dbOverride.errorCount,
          lastUsedAt: dbOverride.lastUsedAt,
          lastUpdatedBy: dbOverride.lastUpdatedBy,
          lastUpdatedByName: dbOverride.lastUpdatedByName,
          updatedAt: dbOverride.updatedAt,
        });
      }

      // Check if tool exists in code
      const codeTool = findCodeTool(toolId);
      if (codeTool) {
        return res.json({
          toolId,
          toolName: codeTool.toolName,
          description: codeTool.description,
          shortDescription:
            codeTool.description.length > 100 ? codeTool.description.substring(0, 100) + '...' : codeTool.description,
          category: codeTool.category,
          tags: [],
          parameters: { type: 'object' },
          enabled: true,
          version: 0,
          source: 'code',
          hasOverride: false,
          usageCount: 0,
          successCount: 0,
          errorCount: 0,
          lastUsedAt: null,
        });
      }

      throw new NotFoundError('Tool not found');
    } catch (error) {
      console.error('Error fetching tool definition:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof ForbiddenError) {
        return res.status(403).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to fetch tool definition' });
    }
  })
  .put(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { toolId } = req.query;

      if (!toolId || typeof toolId !== 'string') {
        throw new BadRequestError('Tool ID is required');
      }

      // Validate request body
      const parseResult = updateSchema.safeParse(req.body);
      if (!parseResult.success) {
        const errorMessages = parseResult.error.issues.map(e => e.message).join(', ');
        throw new BadRequestError(errorMessages);
      }

      const { description, shortDescription, enabled = true } = parseResult.data;

      // Check if override already exists
      const existingOverride = await toolDefinitionOverrideRepository.findByToolId(toolId);

      if (existingOverride) {
        // Update existing override (increments version)
        const updated = await toolDefinitionOverrideRepository.updateDescription(
          toolId,
          description,
          shortDescription,
          enabled,
          req.user!.id,
          req.user!.name || req.user!.email || 'Unknown'
        );

        if (!updated) {
          throw new NotFoundError('Failed to update tool definition');
        }

        return res.json({
          toolId: updated.toolId,
          toolName: updated.toolName,
          description: updated.description,
          shortDescription: updated.shortDescription,
          category: updated.category,
          tags: updated.tags,
          parameters: updated.parameters,
          enabled: updated.enabled,
          version: updated.version,
          source: 'database',
          hasOverride: true,
          usageCount: updated.usageCount,
          successCount: updated.successCount,
          errorCount: updated.errorCount,
          lastUsedAt: updated.lastUsedAt,
          lastUpdatedBy: updated.lastUpdatedBy,
          lastUpdatedByName: updated.lastUpdatedByName,
          updatedAt: updated.updatedAt,
        });
      }

      // Create new override for a code-only tool
      const codeTool = findCodeTool(toolId);
      if (!codeTool) {
        throw new NotFoundError('Tool not found. Cannot create override for non-existent tool.');
      }

      const newOverride = await toolDefinitionOverrideRepository.createOverride({
        toolId,
        toolName: codeTool.toolName,
        description,
        shortDescription,
        category: codeTool.category,
        tags: [],
        parameters: { type: 'object' },
        enabled,
        createdBy: req.user!.id,
        lastUpdatedBy: req.user!.id,
        lastUpdatedByName: req.user!.name || req.user!.email || 'Unknown',
      });

      return res.status(201).json({
        toolId: newOverride.toolId,
        toolName: newOverride.toolName,
        description: newOverride.description,
        shortDescription: newOverride.shortDescription,
        category: newOverride.category,
        tags: newOverride.tags,
        parameters: newOverride.parameters,
        enabled: newOverride.enabled,
        version: newOverride.version,
        source: 'database',
        hasOverride: true,
        usageCount: newOverride.usageCount,
        successCount: newOverride.successCount,
        errorCount: newOverride.errorCount,
        lastUsedAt: newOverride.lastUsedAt,
        lastUpdatedBy: newOverride.lastUpdatedBy,
        lastUpdatedByName: newOverride.lastUpdatedByName,
        updatedAt: newOverride.updatedAt,
      });
    } catch (error) {
      console.error('Error updating tool definition:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof ForbiddenError) {
        return res.status(403).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to update tool definition' });
    }
  })
  .delete(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { toolId } = req.query;

      if (!toolId || typeof toolId !== 'string') {
        throw new BadRequestError('Tool ID is required');
      }

      // Check if override exists
      const existingOverride = await toolDefinitionOverrideRepository.findByToolId(toolId);

      if (!existingOverride) {
        throw new NotFoundError('No override exists for this tool. Nothing to delete.');
      }

      // Verify the tool exists in code (so we can revert to it)
      const codeTool = findCodeTool(toolId);
      if (!codeTool) {
        throw new BadRequestError(
          'Cannot delete override: tool does not exist in code. Deleting would remove the tool entirely.'
        );
      }

      // Soft delete the override
      await toolDefinitionOverrideRepository.softDelete(toolId);

      // Return the code-only tool definition (what it reverts to)
      return res.json({
        toolId,
        toolName: codeTool.toolName,
        description: codeTool.description,
        shortDescription:
          codeTool.description.length > 100 ? codeTool.description.substring(0, 100) + '...' : codeTool.description,
        category: codeTool.category,
        tags: [],
        parameters: { type: 'object' },
        enabled: true,
        version: 0,
        source: 'code',
        hasOverride: false,
        usageCount: 0,
        successCount: 0,
        errorCount: 0,
        lastUsedAt: null,
        message: 'Override deleted. Tool reverted to code defaults.',
      });
    } catch (error) {
      console.error('Error deleting tool definition override:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof ForbiddenError) {
        return res.status(403).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to delete tool definition override' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

import { toolDefinitionOverrideRepository } from '@bike4mind/database';
import { B4MLLMToolsList, MCP_PROVIDER_METADATA } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { TOOL_MAPPING, TOOL_CATEGORIES } from '@client/app/utils/toolMapping';

// Tool definition interface for API response
export interface IToolDefinition {
  toolId: string;
  toolName: string;
  description: string;
  shortDescription: string;
  category: string;
  tags: string[];
  parameters: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
  enabled: boolean;
  version: number;
  source: 'code' | 'database';
  hasOverride: boolean;
  usageCount: number;
  successCount: number;
  errorCount: number;
  lastUsedAt: Date | null;
  lastUpdatedBy?: string;
  lastUpdatedByName?: string;
  updatedAt?: Date;
}

// Extract tags from description
function extractTags(description: string): string[] {
  const keywords = ['search', 'image', 'chart', 'data', 'visualization', 'weather', 'math', 'file', 'blog'];
  const tags: string[] = [];
  const lowerDesc = description.toLowerCase();

  for (const keyword of keywords) {
    if (lowerDesc.includes(keyword)) {
      tags.push(keyword);
    }
  }

  return tags;
}

// Build tool list from code sources
function getCodeTools(): IToolDefinition[] {
  const tools: IToolDefinition[] = [];

  // Add built-in LLM tools
  for (const toolId of B4MLLMToolsList) {
    const mappingInfo = TOOL_MAPPING[toolId as keyof typeof TOOL_MAPPING];
    const description = mappingInfo?.description || `${toolId} tool`;
    const displayName = mappingInfo?.displayName || toolId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    tools.push({
      toolId,
      toolName: displayName,
      description,
      shortDescription: description,
      category: TOOL_CATEGORIES[toolId] || 'Utility',
      tags: extractTags(description),
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

  // Add MCP provider tools
  for (const [providerName, metadata] of Object.entries(MCP_PROVIDER_METADATA)) {
    if (metadata.defaultToolDescriptions) {
      for (const [toolId, description] of Object.entries(metadata.defaultToolDescriptions)) {
        const displayName = toolId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        const category = `MCP: ${providerName.charAt(0).toUpperCase() + providerName.slice(1)}`;

        tools.push({
          toolId: `${providerName}_${toolId}`,
          toolName: displayName,
          description,
          shortDescription: description.length > 100 ? description.substring(0, 100) + '...' : description,
          category,
          tags: [...extractTags(description), providerName],
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
    }
  }

  return tools;
}

// Pagination constants
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const handler = baseApi().get(async (req, res) => {
  try {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { category, enabled, search, source, page: pageParam, limit: limitParam } = req.query;

    // Parse pagination params
    const page = Math.max(1, parseInt(pageParam as string, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limitParam as string, 10) || DEFAULT_PAGE_SIZE));

    // Get all tools from code
    const codeTools = getCodeTools();

    // Get all database overrides
    const dbOverrides = await toolDefinitionOverrideRepository.findAll();
    const overrideMap = new Map(dbOverrides.map(o => [o.toolId, o]));

    // Merge code tools with database overrides
    let tools: IToolDefinition[] = codeTools.map(codeTool => {
      const override = overrideMap.get(codeTool.toolId);
      if (override) {
        return {
          ...codeTool,
          description: override.description,
          shortDescription: override.shortDescription,
          category: override.category || codeTool.category,
          tags: override.tags || codeTool.tags,
          enabled: override.enabled,
          version: override.version,
          source: 'database' as const,
          hasOverride: true,
          usageCount: override.usageCount,
          successCount: override.successCount,
          errorCount: override.errorCount,
          lastUsedAt: override.lastUsedAt,
          lastUpdatedBy: override.lastUpdatedBy,
          lastUpdatedByName: override.lastUpdatedByName,
          updatedAt: override.updatedAt,
        };
      }
      return codeTool;
    });

    // Add any DB-only tools (tools that only exist in the database)
    for (const override of dbOverrides) {
      if (!codeTools.find(t => t.toolId === override.toolId)) {
        tools.push({
          toolId: override.toolId,
          toolName: override.toolName,
          description: override.description,
          shortDescription: override.shortDescription,
          category: override.category,
          tags: override.tags,
          parameters: override.parameters,
          enabled: override.enabled,
          version: override.version,
          source: 'database',
          hasOverride: true,
          usageCount: override.usageCount,
          successCount: override.successCount,
          errorCount: override.errorCount,
          lastUsedAt: override.lastUsedAt,
          lastUpdatedBy: override.lastUpdatedBy,
          lastUpdatedByName: override.lastUpdatedByName,
          updatedAt: override.updatedAt,
        });
      }
    }

    // Extract ALL categories BEFORE filtering
    const allCategories = Array.from(new Set(tools.map(t => t.category))).sort();

    // Apply filters
    if (category && category !== 'all') {
      tools = tools.filter(t => t.category === category);
    }

    if (enabled && enabled !== 'all') {
      const isEnabled = enabled === 'true';
      tools = tools.filter(t => t.enabled === isEnabled);
    }

    if (source && source !== 'all') {
      tools = tools.filter(t => t.source === source);
    }

    if (search && typeof search === 'string' && search.trim()) {
      const searchLower = search.toLowerCase().trim();
      tools = tools.filter(
        t =>
          t.toolId.toLowerCase().includes(searchLower) ||
          t.toolName.toLowerCase().includes(searchLower) ||
          t.description.toLowerCase().includes(searchLower) ||
          t.shortDescription.toLowerCase().includes(searchLower) ||
          t.tags.some(tag => tag.toLowerCase().includes(searchLower))
      );
    }

    // Sort by category, then by name
    tools.sort((a, b) => {
      const catCompare = a.category.localeCompare(b.category);
      if (catCompare !== 0) return catCompare;
      return a.toolName.localeCompare(b.toolName);
    });

    // Calculate pagination
    const total = tools.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const paginatedTools = tools.slice(offset, offset + limit);

    return res.json({
      tools: paginatedTools,
      total,
      categories: allCategories,
      pagination: {
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error('Error fetching tool definitions:', error);
    if (error instanceof ForbiddenError) {
      return res.status(403).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch tool definitions' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

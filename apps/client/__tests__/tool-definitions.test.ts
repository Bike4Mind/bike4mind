import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Mock the database repository
vi.mock('@bike4mind/database', () => ({
  toolDefinitionOverrideRepository: {
    findAll: vi.fn(),
    findByToolId: vi.fn(),
    createOverride: vi.fn(),
    updateDescription: vi.fn(),
    softDelete: vi.fn(),
  },
}));

// Mock the middlewares
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, any> = {};
    const chain = {
      get: (fn: any) => {
        handlers.get = fn;
        return chain;
      },
      put: (fn: any) => {
        handlers.put = fn;
        return chain;
      },
      delete: (fn: any) => {
        handlers.delete = fn;
        return chain;
      },
      // Make the chain callable to get handlers
      _handlers: handlers,
    };
    return chain;
  },
}));

// Mock B4MLLMToolsList - preserve real exports (error classes, etc.)
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  B4MLLMToolsList: ['web_search', 'web_fetch', 'image_generation', 'deep_research'],
  MCP_PROVIDER_METADATA: {},
}));

// Mock TOOL_MAPPING and TOOL_CATEGORIES
vi.mock('@client/app/utils/toolMapping', () => ({
  TOOL_MAPPING: {
    web_search: {
      displayName: 'Web Search',
      description: 'Search the web for information',
    },
    web_fetch: {
      displayName: 'Web Fetch',
      description: 'Fetch and process content from specific URLs',
    },
    image_generation: {
      displayName: 'Image Generation',
      description: 'Generate images from text',
    },
    deep_research: {
      displayName: 'Deep Research',
      description: 'Deep research tool',
    },
  },
  TOOL_CATEGORIES: {
    web_search: 'Search',
    web_fetch: 'Search',
    image_generation: 'Generation',
    deep_research: 'Search',
  },
}));

// Import after mocks
import { toolDefinitionOverrideRepository } from '@bike4mind/database';
import listHandler from '../pages/api/admin/tool-definitions/index';
import toolIdHandler from '../pages/api/admin/tool-definitions/[toolId]';

// Get typed mock functions
const mockFindAll = toolDefinitionOverrideRepository.findAll as ReturnType<typeof vi.fn>;
const mockFindByToolId = toolDefinitionOverrideRepository.findByToolId as ReturnType<typeof vi.fn>;
const mockCreateOverride = toolDefinitionOverrideRepository.createOverride as ReturnType<typeof vi.fn>;
const mockUpdateDescription = toolDefinitionOverrideRepository.updateDescription as ReturnType<typeof vi.fn>;
const mockSoftDelete = toolDefinitionOverrideRepository.softDelete as ReturnType<typeof vi.fn>;

describe('/api/admin/tool-definitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAll.mockResolvedValue([]);
  });

  describe('GET /api/admin/tool-definitions (list)', () => {
    it('should reject non-admin users', async () => {
      const { req, res } = createMocks({
        method: 'GET',
        user: {
          id: 'user123',
          isAdmin: false,
        },
      });

      // Get the handler from the chain
      const handlers = (listHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData()).toEqual({ error: 'Unauthorized. Admin access required.' });
    });

    it('should return list of tools for admin users', async () => {
      mockFindAll.mockResolvedValue([]);

      const { req, res } = createMocks({
        method: 'GET',
        query: {},
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (listHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      const data = res._getJSONData();
      expect(data).toHaveProperty('tools');
      expect(data).toHaveProperty('total');
      expect(data).toHaveProperty('categories');
      expect(data).toHaveProperty('pagination');
      expect(Array.isArray(data.tools)).toBe(true);
    });

    it('should return code-based tools when no overrides exist', async () => {
      mockFindAll.mockResolvedValue([]);

      const { req, res } = createMocks({
        method: 'GET',
        query: {},
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (listHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      const data = res._getJSONData();
      expect(data.tools.length).toBeGreaterThan(0);
      expect(data.tools.every((t: any) => t.source === 'code')).toBe(true);
    });

    it('should merge database overrides with code tools', async () => {
      mockFindAll.mockResolvedValue([
        {
          toolId: 'web_search',
          toolName: 'Custom Web Search',
          description: 'Customized description for web search',
          shortDescription: 'Custom search',
          category: 'Search',
          tags: ['custom'],
          enabled: true,
          version: 2,
          usageCount: 10,
          successCount: 8,
          errorCount: 2,
          lastUsedAt: new Date(),
          lastUpdatedBy: 'admin',
          lastUpdatedByName: 'Admin User',
          updatedAt: new Date(),
        },
      ]);

      const { req, res } = createMocks({
        method: 'GET',
        query: {},
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (listHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      const data = res._getJSONData();
      const webSearchTool = data.tools.find((t: any) => t.toolId === 'web_search');
      expect(webSearchTool).toBeDefined();
      expect(webSearchTool.source).toBe('database');
      expect(webSearchTool.hasOverride).toBe(true);
      expect(webSearchTool.description).toBe('Customized description for web search');
    });

    it('should support pagination', async () => {
      mockFindAll.mockResolvedValue([]);

      const { req, res } = createMocks({
        method: 'GET',
        query: { page: '2', limit: '10' },
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (listHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      const data = res._getJSONData();
      expect(data.pagination).toBeDefined();
      expect(data.pagination.page).toBe(2);
      expect(data.pagination.limit).toBe(10);
    });

    it('should filter by category', async () => {
      mockFindAll.mockResolvedValue([]);

      const { req, res } = createMocks({
        method: 'GET',
        query: { category: 'Search' },
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (listHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      const data = res._getJSONData();
      expect(data.tools.every((t: any) => t.category === 'Search')).toBe(true);
    });
  });

  describe('GET /api/admin/tool-definitions/[toolId]', () => {
    it('should reject non-admin users', async () => {
      const { req, res } = createMocks({
        method: 'GET',
        query: { toolId: 'web_search' },
        user: {
          id: 'user123',
          isAdmin: false,
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      expect(res._getStatusCode()).toBe(403);
    });

    it('should return code tool when no override exists', async () => {
      mockFindByToolId.mockResolvedValue(null);

      const { req, res } = createMocks({
        method: 'GET',
        query: { toolId: 'web_search' },
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      const data = res._getJSONData();
      expect(data.toolId).toBe('web_search');
      expect(data.source).toBe('code');
      expect(data.hasOverride).toBe(false);
    });

    it('should return database override when it exists', async () => {
      mockFindByToolId.mockResolvedValue({
        toolId: 'web_search',
        toolName: 'Custom Web Search',
        description: 'Custom description',
        shortDescription: 'Custom',
        category: 'Search',
        tags: [],
        parameters: { type: 'object' },
        enabled: true,
        version: 3,
        usageCount: 5,
        successCount: 5,
        errorCount: 0,
        lastUsedAt: null,
      });

      const { req, res } = createMocks({
        method: 'GET',
        query: { toolId: 'web_search' },
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      const data = res._getJSONData();
      expect(data.source).toBe('database');
      expect(data.hasOverride).toBe(true);
    });

    it('should return 404 for unknown tool', async () => {
      mockFindByToolId.mockResolvedValue(null);

      const { req, res } = createMocks({
        method: 'GET',
        query: { toolId: 'nonexistent_tool' },
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.get(req as any, res as any);

      expect(res._getStatusCode()).toBe(404);
    });
  });

  describe('PUT /api/admin/tool-definitions/[toolId]', () => {
    it('should reject non-admin users', async () => {
      const { req, res } = createMocks({
        method: 'PUT',
        query: { toolId: 'web_search' },
        body: {
          description: 'A'.repeat(50),
          shortDescription: 'Short desc',
        },
        user: {
          id: 'user123',
          isAdmin: false,
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.put(req as any, res as any);

      expect(res._getStatusCode()).toBe(403);
    });

    it('should validate description minimum length', async () => {
      const { req, res } = createMocks({
        method: 'PUT',
        query: { toolId: 'web_search' },
        body: {
          description: 'Too short',
          shortDescription: 'Short desc',
        },
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.put(req as any, res as any);

      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toContain('at least 50 characters');
    });

    it('should create override for code-only tool', async () => {
      mockFindByToolId.mockResolvedValue(null);
      mockCreateOverride.mockResolvedValue({
        toolId: 'web_search',
        toolName: 'Web Search',
        description: 'A'.repeat(50),
        shortDescription: 'Short description',
        category: 'Search',
        tags: [],
        parameters: { type: 'object' },
        enabled: true,
        version: 1,
        usageCount: 0,
        successCount: 0,
        errorCount: 0,
        lastUsedAt: null,
        lastUpdatedBy: 'admin123',
        lastUpdatedByName: 'Admin User',
        updatedAt: new Date(),
      });

      const { req, res } = createMocks({
        method: 'PUT',
        query: { toolId: 'web_search' },
        body: {
          description: 'A'.repeat(50),
          shortDescription: 'Short description',
        },
        user: {
          id: 'admin123',
          isAdmin: true,
          name: 'Admin User',
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.put(req as any, res as any);

      expect(res._getStatusCode()).toBe(201);
      expect(mockCreateOverride).toHaveBeenCalled();
    });

    it('should update existing override', async () => {
      mockFindByToolId.mockResolvedValue({
        toolId: 'web_search',
        toolName: 'Web Search',
        description: 'Old description',
        shortDescription: 'Old short',
        category: 'Search',
        tags: [],
        parameters: { type: 'object' },
        enabled: true,
        version: 1,
      });
      mockUpdateDescription.mockResolvedValue({
        toolId: 'web_search',
        toolName: 'Web Search',
        description: 'A'.repeat(50),
        shortDescription: 'New short description',
        category: 'Search',
        tags: [],
        parameters: { type: 'object' },
        enabled: true,
        version: 2,
        usageCount: 0,
        successCount: 0,
        errorCount: 0,
        lastUsedAt: null,
        lastUpdatedBy: 'admin123',
        lastUpdatedByName: 'Admin User',
        updatedAt: new Date(),
      });

      const { req, res } = createMocks({
        method: 'PUT',
        query: { toolId: 'web_search' },
        body: {
          description: 'A'.repeat(50),
          shortDescription: 'New short description',
        },
        user: {
          id: 'admin123',
          isAdmin: true,
          name: 'Admin User',
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.put(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(mockUpdateDescription).toHaveBeenCalled();
    });
  });

  describe('DELETE /api/admin/tool-definitions/[toolId]', () => {
    it('should reject non-admin users', async () => {
      const { req, res } = createMocks({
        method: 'DELETE',
        query: { toolId: 'web_search' },
        user: {
          id: 'user123',
          isAdmin: false,
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.delete(req as any, res as any);

      expect(res._getStatusCode()).toBe(403);
    });

    it('should return 404 when no override exists', async () => {
      mockFindByToolId.mockResolvedValue(null);

      const { req, res } = createMocks({
        method: 'DELETE',
        query: { toolId: 'web_search' },
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.delete(req as any, res as any);

      expect(res._getStatusCode()).toBe(404);
      expect(res._getJSONData().error).toContain('No override exists');
    });

    it('should soft delete existing override and return code defaults', async () => {
      mockFindByToolId.mockResolvedValue({
        toolId: 'web_search',
        toolName: 'Custom Web Search',
        description: 'Custom description',
        shortDescription: 'Custom',
        category: 'Search',
        tags: [],
        parameters: { type: 'object' },
        enabled: true,
        version: 3,
      });
      mockSoftDelete.mockResolvedValue(true);

      const { req, res } = createMocks({
        method: 'DELETE',
        query: { toolId: 'web_search' },
        user: {
          id: 'admin123',
          isAdmin: true,
        },
      });

      const handlers = (toolIdHandler as any)._handlers;
      await handlers.delete(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(mockSoftDelete).toHaveBeenCalledWith('web_search');
      const data = res._getJSONData();
      expect(data.source).toBe('code');
      expect(data.hasOverride).toBe(false);
      expect(data.message).toContain('reverted to code defaults');
    });
  });
});

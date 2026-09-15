import { describe, it, expect, vi } from 'vitest';
import { generateMcpTools } from './index';

// Minimal mock MCP data that satisfies the function signature
function createMockMcpData(tools: unknown[]) {
  return {
    serverName: 'github',
    getTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({ content: [{ text: 'ok' }] }),
  };
}

describe('generateMcpTools', () => {
  describe('schema properties fix', () => {
    it('should add empty properties to object schema without properties', async () => {
      const mcpData = createMockMcpData([
        {
          name: 'current_user',
          description: 'Get current user',
          input_schema: { type: 'object' },
        },
      ]);

      const result = await generateMcpTools(mcpData);

      expect(result).toHaveLength(1);
      expect(result[0].toolSchema.parameters).toEqual({
        type: 'object',
        properties: {},
      });
    });

    it('should preserve existing properties on object schema', async () => {
      const mcpData = createMockMcpData([
        {
          name: 'list_issues',
          description: 'List issues',
          input_schema: {
            type: 'object',
            properties: {
              repo: { type: 'string' },
              state: { type: 'string' },
            },
            required: ['repo'],
          },
        },
      ]);

      const result = await generateMcpTools(mcpData);

      expect(result[0].toolSchema.parameters.properties).toEqual({
        repo: { type: 'string' },
        state: { type: 'string' },
      });
      expect(result[0].toolSchema.parameters.required).toEqual(['repo']);
    });

    it('should use fallback schema when rawParameters is null/undefined', async () => {
      const mcpData = createMockMcpData([
        {
          name: 'no_params_tool',
          description: 'A tool with no schema',
        },
      ]);

      const result = await generateMcpTools(mcpData);

      expect(result[0].toolSchema.parameters).toEqual({
        type: 'object',
        properties: {},
        additionalProperties: true,
      });
    });
  });

  describe('namespacing', () => {
    it('should namespace tool names with server name', async () => {
      const mcpData = createMockMcpData([
        {
          name: 'create_issue',
          description: 'Create an issue',
          input_schema: { type: 'object', properties: {} },
        },
      ]);

      const result = await generateMcpTools(mcpData);

      expect(result[0].name).toBe('github__create_issue');
      expect(result[0].toolSchema.name).toBe('github__create_issue');
    });
  });

  describe('empty/error cases', () => {
    it('should return empty array when getTools returns empty', async () => {
      const mcpData = createMockMcpData([]);
      const result = await generateMcpTools(mcpData);
      expect(result).toEqual([]);
    });
  });
});

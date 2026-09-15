import { describe, it, expect } from 'vitest';
import { createDecomposeTaskTool, type DecompositionCapture } from './decomposeTaskTool';

describe('decomposeTaskTool', () => {
  const createCapture = (): DecompositionCapture => ({ result: null });

  describe('toolSchema', () => {
    it('should have correct tool name', () => {
      const capture = createCapture();
      const tool = createDecomposeTaskTool(capture);
      expect(tool.toolSchema.name).toBe('decompose_task');
    });

    it('should require tasks parameter', () => {
      const capture = createCapture();
      const tool = createDecomposeTaskTool(capture);
      expect(tool.toolSchema.parameters.required).toContain('tasks');
    });
  });

  describe('toolFn', () => {
    it('should accept valid task decomposition', async () => {
      const capture = createCapture();
      const tool = createDecomposeTaskTool(capture);

      const result = await tool.toolFn({
        tasks: [
          { id: 'explore-auth', description: 'Find auth files', agentType: 'explore' },
          { id: 'implement', description: 'Write code', agentType: 'general-purpose', dependsOn: ['explore-auth'] },
        ],
      });

      expect(capture.result).not.toBeNull();
      expect(capture.result!.tasks).toHaveLength(2);
      expect(result).toContain('Task decomposition accepted');
      expect(result).toContain('2 tasks');
    });

    it('should capture validated result', async () => {
      const capture = createCapture();
      const tool = createDecomposeTaskTool(capture);

      await tool.toolFn({
        tasks: [{ id: 'task1', description: 'Do something', agentType: 'review' }],
      });

      expect(capture.result).not.toBeNull();
      expect(capture.result!.tasks[0].id).toBe('task1');
      expect(capture.result!.tasks[0].agentType).toBe('review');
      expect(capture.result!.tasks[0].dependsOn).toEqual([]);
    });

    it('should reject invalid agent type', async () => {
      const capture = createCapture();
      const tool = createDecomposeTaskTool(capture);

      await expect(
        tool.toolFn({
          tasks: [{ id: 'task1', description: 'Bad task', agentType: 'nonexistent' }],
        })
      ).rejects.toThrow('Invalid task decomposition');
      expect(capture.result).toBeNull();
    });

    it('should reject empty tasks array', async () => {
      const capture = createCapture();
      const tool = createDecomposeTaskTool(capture);

      await expect(tool.toolFn({ tasks: [] })).rejects.toThrow('Invalid task decomposition');
      expect(capture.result).toBeNull();
    });

    it('should reject duplicate task IDs', async () => {
      const capture = createCapture();
      const tool = createDecomposeTaskTool(capture);

      await expect(
        tool.toolFn({
          tasks: [
            { id: 'dupe', description: 'First', agentType: 'explore' },
            { id: 'dupe', description: 'Second', agentType: 'explore' },
          ],
        })
      ).rejects.toThrow('Duplicate task IDs: dupe');
      expect(capture.result).toBeNull();
    });

    it('should reject second call after successful decomposition', async () => {
      const capture = createCapture();
      const tool = createDecomposeTaskTool(capture);

      // First call succeeds
      await tool.toolFn({
        tasks: [{ id: 'a', description: 'First', agentType: 'explore' }],
      });
      expect(capture.result).not.toBeNull();

      // Second call is rejected without overwriting
      const result = await tool.toolFn({
        tasks: [{ id: 'b', description: 'Second', agentType: 'plan' }],
      });
      expect(result).toContain('already accepted');
      expect(capture.result!.tasks[0].id).toBe('a'); // Original preserved
    });

    it('should include dependency info in result', async () => {
      const capture = createCapture();
      const tool = createDecomposeTaskTool(capture);

      const result = await tool.toolFn({
        tasks: [
          { id: 'a', description: 'First', agentType: 'explore' },
          { id: 'b', description: 'Second', agentType: 'plan', dependsOn: ['a'] },
        ],
      });

      expect(result).toContain('depends on: a');
    });
  });
});

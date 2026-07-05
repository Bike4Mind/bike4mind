import { describe, it, expect, vi } from 'vitest';
import { createDynamicAgentTool } from './dynamicAgentTool.js';
import { DEFAULT_AGENT_MODEL, DEFAULT_MAX_ITERATIONS, DEFAULT_THOROUGHNESS } from './types.js';

function createMockOrchestrator() {
  return {
    delegateToAgent: vi.fn().mockResolvedValue({
      agentName: 'test-agent',
      thoroughness: 'medium',
      summary: 'Mock agent completed successfully',
      parentSessionId: 'session-123',
      finalAnswer: 'Done',
      steps: [],
      completionInfo: {
        totalTokens: 500,
        iterations: 3,
        toolCalls: 5,
        reachedMaxIterations: false,
      },
    }),
    getAvailableAgents: vi.fn().mockReturnValue([]),
    hasAgent: vi.fn().mockReturnValue(false),
  };
}

function createMockBackgroundManager() {
  return {
    spawn: vi.fn().mockReturnValue('bg-abc123'),
    getJob: vi.fn(),
    getAllJobs: vi.fn().mockReturnValue([]),
    cancel: vi.fn(),
  };
}

describe('createDynamicAgentTool', () => {
  const sessionId = 'session-123';

  it('returns a tool with correct schema name', () => {
    const orchestrator = createMockOrchestrator();
    const tool = createDynamicAgentTool(orchestrator as never, sessionId);

    expect(tool.toolSchema.name).toBe('create_dynamic_agent');
  });

  it('requires task, name, and systemPrompt parameters', () => {
    const orchestrator = createMockOrchestrator();
    const tool = createDynamicAgentTool(orchestrator as never, sessionId);

    expect(tool.toolSchema.parameters.required).toEqual(['task', 'name', 'systemPrompt']);
  });

  describe('parameter validation', () => {
    it('throws when task is missing', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await expect(tool.toolFn({ name: 'test', systemPrompt: 'prompt' })).rejects.toThrow(
        'create_dynamic_agent: task parameter is required'
      );
    });

    it('throws when name is missing', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await expect(tool.toolFn({ task: 'do something', systemPrompt: 'prompt' })).rejects.toThrow(
        'create_dynamic_agent: name parameter is required'
      );
    });

    it('throws when systemPrompt is missing', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await expect(tool.toolFn({ task: 'do something', name: 'test' })).rejects.toThrow(
        'create_dynamic_agent: systemPrompt parameter is required'
      );
    });

    it('throws when name contains spaces', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await expect(tool.toolFn({ task: 'do something', name: 'my agent', systemPrompt: 'prompt' })).rejects.toThrow(
        'name must contain only alphanumeric characters, hyphens, and underscores'
      );
    });

    it('throws when name contains special characters', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await expect(tool.toolFn({ task: 'do something', name: 'agent@v2!', systemPrompt: 'prompt' })).rejects.toThrow(
        'name must contain only alphanumeric characters, hyphens, and underscores'
      );
    });

    it('accepts valid names with hyphens and underscores', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'my-agent_v2',
        systemPrompt: 'prompt',
      });

      expect(orchestrator.delegateToAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe('foreground execution', () => {
    it('calls orchestrator.delegateToAgent with correct agentDefinition', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'review code',
        name: 'security-auditor',
        systemPrompt: 'You are a security auditor.',
      });

      expect(orchestrator.delegateToAgent).toHaveBeenCalledTimes(1);
      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];

      expect(callArgs.task).toBe('review code');
      expect(callArgs.agentName).toBe('security-auditor');
      expect(callArgs.parentSessionId).toBe(sessionId);
      expect(callArgs.agentDefinition).toBeDefined();
      expect(callArgs.agentDefinition.systemPrompt).toBe('You are a security auditor.');
      expect(callArgs.agentDefinition.description).toBe('Dynamic agent: security-auditor');
    });

    it('returns the summary from the orchestrator result', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      const result = await tool.toolFn({
        task: 'review code',
        name: 'test-agent',
        systemPrompt: 'You are helpful.',
      });

      expect(result).toBe('Mock agent completed successfully');
    });

    it('uses DEFAULT_AGENT_MODEL when no model specified', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'test-agent',
        systemPrompt: 'prompt',
      });

      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];
      expect(callArgs.agentDefinition.model).toBe(DEFAULT_AGENT_MODEL);
    });

    it('uses custom model when provided', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'test-agent',
        systemPrompt: 'prompt',
        model: 'claude-sonnet-4-5-20250929',
      });

      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];
      expect(callArgs.agentDefinition.model).toBe('claude-sonnet-4-5-20250929');
      expect(callArgs.model).toBe('claude-sonnet-4-5-20250929');
    });

    it('passes thoroughness and variables through', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'test-agent',
        systemPrompt: 'You check $DOMAIN code.',
        thoroughness: 'very_thorough',
        variables: { DOMAIN: 'auth' },
      });

      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];
      expect(callArgs.thoroughness).toBe('very_thorough');
      expect(callArgs.variables).toEqual({ DOMAIN: 'auth' });
    });

    it('passes allowedTools to spawn options', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'test-agent',
        systemPrompt: 'prompt',
        allowedTools: ['file_read', 'grep_search'],
      });

      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];
      expect(callArgs.allowedTools).toEqual(['file_read', 'grep_search']);
      expect(callArgs.agentDefinition.allowedTools).toEqual(['file_read', 'grep_search']);
    });

    it('uses default description when none provided', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'my-agent',
        systemPrompt: 'prompt',
      });

      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];
      expect(callArgs.agentDefinition.description).toBe('Dynamic agent: my-agent');
    });

    it('uses custom description when provided', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'my-agent',
        systemPrompt: 'prompt',
        description: 'A custom security scanner',
      });

      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];
      expect(callArgs.agentDefinition.description).toBe('A custom security scanner');
    });

    it('sets default maxIterations and thoroughness on agentDefinition', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'test-agent',
        systemPrompt: 'prompt',
      });

      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];
      expect(callArgs.agentDefinition.maxIterations).toEqual(DEFAULT_MAX_ITERATIONS);
      expect(callArgs.agentDefinition.defaultThoroughness).toBe(DEFAULT_THOROUGHNESS);
    });
  });

  describe('denied tools (anti-recursion)', () => {
    it('always denies agent_delegate and create_dynamic_agent', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'test-agent',
        systemPrompt: 'prompt',
      });

      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];
      expect(callArgs.agentDefinition.deniedTools).toContain('agent_delegate');
      expect(callArgs.agentDefinition.deniedTools).toContain('create_dynamic_agent');
    });

    it('merges user-provided deniedTools with always-denied tools', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await tool.toolFn({
        task: 'test task',
        name: 'test-agent',
        systemPrompt: 'prompt',
        deniedTools: ['bash_execute', 'create_file'],
      });

      const callArgs = orchestrator.delegateToAgent.mock.calls[0][0];
      const denied = callArgs.agentDefinition.deniedTools;
      expect(denied).toContain('bash_execute');
      expect(denied).toContain('create_file');
      expect(denied).toContain('agent_delegate');
      expect(denied).toContain('create_dynamic_agent');
    });
  });

  describe('background execution', () => {
    it('spawns background job and returns job ID', async () => {
      const orchestrator = createMockOrchestrator();
      const bgManager = createMockBackgroundManager();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId, bgManager as never);

      const result = await tool.toolFn({
        task: 'long running task',
        name: 'bg-agent',
        systemPrompt: 'prompt',
        run_in_background: true,
      });

      expect(bgManager.spawn).toHaveBeenCalledTimes(1);
      expect(orchestrator.delegateToAgent).not.toHaveBeenCalled();
      expect(result).toContain('bg-abc123');
      expect(result).toContain('bg-agent');
    });

    it('passes group_description to background manager', async () => {
      const orchestrator = createMockOrchestrator();
      const bgManager = createMockBackgroundManager();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId, bgManager as never);

      await tool.toolFn({
        task: 'test task',
        name: 'bg-agent',
        systemPrompt: 'prompt',
        run_in_background: true,
        group_description: 'Security audit batch',
      });

      const spawnArgs = bgManager.spawn.mock.calls[0][0];
      expect(spawnArgs.groupDescription).toBe('Security audit batch');
    });

    it('propagates orchestrator errors', async () => {
      const orchestrator = createMockOrchestrator();
      orchestrator.delegateToAgent.mockRejectedValue(new Error('Agent failed'));
      const tool = createDynamicAgentTool(orchestrator as never, sessionId);

      await expect(tool.toolFn({ task: 'test task', name: 'test-agent', systemPrompt: 'prompt' })).rejects.toThrow(
        'Agent failed'
      );
    });

    it('falls back to foreground when no background manager', async () => {
      const orchestrator = createMockOrchestrator();
      const tool = createDynamicAgentTool(orchestrator as never, sessionId); // no bgManager

      const result = await tool.toolFn({
        task: 'test task',
        name: 'test-agent',
        systemPrompt: 'prompt',
        run_in_background: true,
      });

      expect(orchestrator.delegateToAgent).toHaveBeenCalledTimes(1);
      expect(result).toBe('Mock agent completed successfully');
    });
  });
});

/**
 * Every tool the CLI builds itself must have a core descriptor. A missing one would fall back
 * to the unknown-tool policy (prompt_default, read-only) and silently change how it is gated.
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ApiClient } from '../../auth/ApiClient.js';
import type { ConfigStore } from '../../storage/ConfigStore.js';
import { PermissionManager } from '../../utils/PermissionManager.js';
import { buildCliToolList, generateCliTools } from '../../utils/toolsAdapter.js';
import { createAgentDelegateTool } from '../../agents/delegateTool.js';
import { createBackgroundAgentTools } from '../../agents/backgroundTools.js';
import { createResumeAgentTool } from '../../agents/resumeAgentTool.js';
import { createDynamicAgentTool } from '../../agents/dynamicAgentTool.js';
import { createCoordinateTaskTool } from '../../agents/coordinatorTool.js';
import { createDecomposeTaskTool } from '../../agents/decomposeTaskTool.js';
import { SubagentOrchestrator } from '../../agents/SubagentOrchestrator.js';
import { createWriteTodosTool, createTodoStore } from '../writeTodosTool.js';
import { createDecisionLogTool, createDecisionStore } from '../decisionLogTool.js';
import { createBlockerTools, createBlockerStore } from '../blockerTool.js';
import { createReviewGateTool, createReviewGateStore } from '../reviewGateTool.js';
import { createFindDefinitionTool } from '../findDefinitionTool.js';
import { createGetFileStructureTool } from '../getFileStructure/index.js';
import { createWorkItemTools } from '../workItemTools.js';
import { createSkillTool } from '../skillTool.js';
import { createToolSearchTool } from '../toolSearchTool.js';
import { CORE_TOOL_DESCRIPTORS } from './coreToolDescriptors.js';
import { ToolCatalog } from './toolCatalog.js';

function names(tools: ICompletionOptionTools[]): string[] {
  return tools.map(tool => tool.toolSchema.name);
}

function missingDescriptors(toolNames: string[]): string[] {
  return toolNames.filter(name => !CORE_TOOL_DESCRIPTORS.has(name));
}

function makePermissionManager(): PermissionManager {
  return new PermissionManager(new ToolCatalog(), [], []);
}

describe('core descriptor completeness', () => {
  it('covers every tool generateCliTools builds with every option on', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-complete-'));
    const { tools } = await generateCliTools(
      'user-1',
      {} as never, // llm: not exercised while tool schemas are built
      'test-model',
      makePermissionManager(),
      vi.fn(async () => ({ action: 'allow-once' as const })),
      { currentAgent: null },
      {} as ConfigStore,
      {} as ApiClient,
      undefined, // toolFilter: a filter only removes tools
      vi.fn(async () => ({ answers: {} }) as never), // showUserQuestion
      { createCheckpoint: vi.fn() } as never, // checkpointStore
      { shouldSandbox: vi.fn() } as never, // sandboxOrchestrator
      [dir],
      'normal'
    );

    expect(tools.length).toBeGreaterThan(0);
    expect(missingDescriptors(names(tools))).toEqual([]);
  });

  it('covers every tool buildCliToolList can assemble', () => {
    // Factories only build schemas here; none of the stubbed collaborators is called.
    const orchestrator = {} as never;
    const agentStore = { getAllAgents: () => [], getAgentNames: () => [] } as never;
    const wrapped = buildCliToolList(
      {
        toolSearchTool: createToolSearchTool(() => []),
        agentDelegateTool: createAgentDelegateTool(orchestrator, agentStore, 'session-1'),
        backgroundTools: createBackgroundAgentTools({} as never),
        resumeAgentTool: createResumeAgentTool(orchestrator, {} as never),
        writeTodosTool: createWriteTodosTool(createTodoStore()),
        decisionLogTool: createDecisionLogTool(createDecisionStore()),
        blockerTools: createBlockerTools(createBlockerStore()),
        reviewGateTool: createReviewGateTool(createReviewGateStore(), vi.fn()),
        findDefinitionTool: createFindDefinitionTool([]),
        getFileStructureTool: createGetFileStructureTool([]),
        workItemTools: createWorkItemTools({} as never),
        skillTool: createSkillTool({ customCommandStore: {} as never, permission: {} as never }),
        dynamicAgentTool: createDynamicAgentTool(orchestrator, 'session-1'),
        coordinateTaskTool: createCoordinateTaskTool(orchestrator, agentStore, 'session-1'),
      },
      {
        permissionManager: makePermissionManager(),
        showPermissionPrompt: vi.fn(),
        agentContext: { currentAgent: null },
        configStore: {},
        apiClient: {} as ApiClient,
      }
    );

    expect(missingDescriptors(names(wrapped))).toEqual([]);
  });

  it('covers the tools a subagent is handed outside buildCliToolList', () => {
    const sharedContextTools = SubagentOrchestrator.prototype['buildSharedContextTools'].call(
      {},
      {} as never,
      ['read', 'write'],
      'agent-1'
    );
    const injected = [...sharedContextTools, createDecomposeTaskTool({ result: null })];

    expect(names(injected)).toEqual(['shared_context_read', 'shared_context_write', 'decompose_task']);
    expect(missingDescriptors(names(injected))).toEqual([]);
  });
});

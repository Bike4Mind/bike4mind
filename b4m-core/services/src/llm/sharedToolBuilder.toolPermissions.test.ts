/**
 * buildSharedTools is the first hop that carries the agent executor's permission lists toward a
 * child (`ToolBuilderDeps.toolPermissions` -> delegate_to_agent / coordinate_task). Build-only
 * stubs, as in sharedToolBuilder.videoGate.test.ts; the tool factories are mocked so the test
 * reads exactly what each one was handed.
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';
import { buildSharedTools, type ToolBuilderDeps, type ToolBuilderCallbacks } from './sharedToolBuilder';
import { ServerAgentStore } from './agents/ServerAgentStore';
import { createDelegateToAgentTool } from './tools/implementation/delegateToAgent';
import { createCoordinateTaskTool } from './tools/implementation/coordinateTask';

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getLlmByModel: vi.fn(() => ({ complete: vi.fn(), currentModel: '' })),
}));

const stubTool = (name: string) => ({
  toolFn: vi.fn(),
  toolSchema: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
});

vi.mock('./tools/implementation/delegateToAgent', async importOriginal => ({
  ...(await importOriginal<typeof import('./tools/implementation/delegateToAgent')>()),
  createDelegateToAgentTool: vi.fn(() => stubTool('delegate_to_agent')),
}));

vi.mock('./tools/implementation/coordinateTask', async importOriginal => ({
  ...(await importOriginal<typeof import('./tools/implementation/coordinateTask')>()),
  createCoordinateTaskTool: vi.fn(() => stubTool('coordinate_task')),
}));

const rejectIfExecuted = (surface: string) => () => {
  throw new Error(`${surface} was called - these tests are build-only and must never execute a tool.`);
};

const fakeStorage = {
  upload: rejectIfExecuted('storage.upload'),
  getSignedUrl: rejectIfExecuted('storage.getSignedUrl'),
  getPublicUrl: rejectIfExecuted('storage.getPublicUrl'),
} as unknown as ToolBuilderDeps['storage'];

const toolPermissions = { approvedTools: ['send_slack_message'], deniedTools: ['web_search'] };

const deps: ToolBuilderDeps = {
  userId: 'test-user',
  user: { _id: 'test-user', id: 'test-user' } as unknown as IUserDocument,
  logger: new Logger(),
  db: {
    apiKeys: {
      findByUserIdAndType: rejectIfExecuted('db.apiKeys.findByUserIdAndType'),
      findByUserIdAndTypes: rejectIfExecuted('db.apiKeys.findByUserIdAndTypes'),
    },
    adminSettings: {
      findBySettingName: rejectIfExecuted('db.adminSettings.findBySettingName'),
      findBySettingNames: rejectIfExecuted('db.adminSettings.findBySettingNames'),
      findAll: rejectIfExecuted('db.adminSettings.findAll'),
    },
  } as unknown as ToolBuilderDeps['db'],
  storage: fakeStorage,
  imageGenerateStorage: fakeStorage,
  llm: { complete: rejectIfExecuted('llm.complete') } as unknown as ICompletionBackend,
  agentStore: new ServerAgentStore({}),
  dagDispatcher: { createNode: vi.fn(), dispatchNode: vi.fn() },
  getCurrentExecutionId: () => 'exec-1',
  toolPermissions,
};

const callbacks: ToolBuilderCallbacks = {
  onStatusUpdate: async () => {},
  onToolStart: async () => {},
  onToolFinish: async () => {},
};

describe('buildSharedTools: subagent permission lists', () => {
  it('hands the lists to both delegation tools', () => {
    buildSharedTools(deps, callbacks, {});

    expect(createDelegateToAgentTool).toHaveBeenCalledWith(expect.objectContaining({ toolPermissions }));
    expect(createCoordinateTaskTool).toHaveBeenCalledWith(expect.objectContaining({ toolPermissions }));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatModels, ModelBackend, type ModelInfo } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { CliConfig } from '../storage';
import { FallbackLlmBackend } from '../llm/FallbackLlmBackend.js';
import { NotifyingLlmBackend } from '../llm/NotifyingLlmBackend.js';
import { ToolSearchLlmBackend } from '../llm/ToolSearchLlmBackend.js';
import { deferredToolRegistry } from '../tools/deferredToolRegistry.js';
import { AcpServer } from './AcpServer.js';

const NATIVE = ChatModels.CLAUDE_5_5_OPUS;
const OPENAI = ChatModels.GPT4o;

const h = vi.hoisted(() => {
  const makeTool = (name: string) => ({
    toolSchema: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
    toolFn: async () => `${name} ran`,
  });
  return {
    makeTool,
    inner: {
      currentModel: 'test',
      complete: async () => {},
      pushToolMessages: () => {},
      getModelInfo: async () => [],
    },
    models: [] as unknown[],
    captured: {} as { llm?: unknown; tools?: Array<{ toolSchema: { name: string } }> },
  };
});

vi.mock('../bootstrap/buildLlmBackend.js', () => ({
  buildLlmBackend: vi.fn(async () => ({
    llm: h.inner,
    wsManager: undefined,
    models: h.models,
    modelInfo: { id: NATIVE },
  })),
}));

vi.mock('../bootstrap/buildSandbox.js', () => ({
  buildSandbox: vi.fn(async () => ({ sandboxOrchestrator: null })),
}));

vi.mock('../bootstrap/buildSupportingStores.js', () => ({
  buildSupportingStores: vi.fn(async () => ({
    agentStore: {},
    contextResult: { mergedContent: '' },
    loadedB4mTools: [h.makeTool('read_file')],
    orchestrator: {},
    backgroundManager: { drainNotifications: () => [] },
    historyStore: {},
    mcpManager: { disconnect: async () => {} },
  })),
}));

vi.mock('../bootstrap/buildAgent.js', () => ({
  buildAgent: vi.fn((input: { notifyingLlm: unknown; allTools: Array<{ toolSchema: { name: string } }> }) => {
    h.captured = { llm: input.notifyingLlm, tools: input.allTools };
    return { agent: { removeAllListeners: () => {} }, buildPromptForMode: () => '' };
  }),
}));

const config = {
  apiConfig: { customUrl: 'http://localhost:3000' },
  preferences: {},
  fallbackModels: [OPENAI],
  trustedTools: [],
  tools: {},
} as unknown as CliConfig;

type StackInternals = {
  configStore: Record<string, unknown>;
  loadCustomCommands: () => Promise<void>;
  mergeRemoteSkills: () => Promise<void>;
  resolveAdditionalDirectories: () => Promise<string[]>;
  buildCliTools: (input: { toolSearchTool?: ICompletionOptionTools | null }) => ICompletionOptionTools[];
  buildStack: () => Promise<unknown>;
};

function serverWithStubbedBootstrap(): AcpServer {
  const server = new AcpServer(new AbortController().signal, 'test');
  const internals = server as unknown as StackInternals;
  internals.configStore = {
    load: async () => config,
    warnPendingMcpApprovals: () => {},
    getAuthTokens: async () => ({ accessToken: 'token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    getProjectConfigDir: () => process.cwd(),
    getAdditionalDirectories: async () => [],
    isProjectTrusted: () => true,
  };
  internals.loadCustomCommands = async () => {};
  internals.mergeRemoteSkills = async () => {};
  internals.resolveAdditionalDirectories = async () => [];
  internals.buildCliTools = input => (input.toolSearchTool ? [input.toolSearchTool] : []);
  return server;
}

async function buildStack(server: AcpServer): Promise<void> {
  await (server as unknown as StackInternals).buildStack();
}

const unwrap = (backend: unknown) => (backend as { inner: unknown }).inner;

describe('AcpServer agent stack', () => {
  beforeEach(() => {
    h.models = [
      { id: NATIVE, backend: ModelBackend.Anthropic },
      { id: OPENAI, backend: ModelBackend.OpenAI },
    ] as ModelInfo[];
    h.captured = {};
    deferredToolRegistry.register([h.makeTool('mcp__a') as ICompletionOptionTools]);
  });

  afterEach(() => {
    deferredToolRegistry.clear();
  });

  it('wraps the LLM in tool search, then fallback, then notifications, and wires tool_search', async () => {
    await buildStack(serverWithStubbedBootstrap());

    const notifying = h.captured.llm;
    expect(notifying).toBeInstanceOf(NotifyingLlmBackend);
    const fallback = unwrap(notifying);
    expect(fallback).toBeInstanceOf(FallbackLlmBackend);
    const toolSearch = unwrap(fallback);
    expect(toolSearch).toBeInstanceOf(ToolSearchLlmBackend);
    expect(unwrap(toolSearch)).toBe(h.inner);

    expect(h.captured.tools?.map(t => t.toolSchema.name)).toContain('tool_search');
  });

  it('leaves the LLM unwrapped when no tools are deferred', async () => {
    deferredToolRegistry.clear();
    await buildStack(serverWithStubbedBootstrap());

    const notifying = h.captured.llm;
    expect(notifying).toBeInstanceOf(NotifyingLlmBackend);
    const fallback = unwrap(notifying);
    expect(fallback).toBeInstanceOf(FallbackLlmBackend);
    expect(unwrap(fallback)).toBe(h.inner);
    expect(h.captured.tools?.map(t => t.toolSchema.name)).not.toContain('tool_search');
  });
});

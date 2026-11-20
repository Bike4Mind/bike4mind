import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { FuzzyEditConfirmationRequiredError } from '@bike4mind/services/llm/tools/cliTools';
import type { ApiClient } from '../../auth/ApiClient.js';
import type { CheckpointStore } from '../../storage/CheckpointStore.js';
import { PermissionManager } from '../../utils/PermissionManager.js';
import { useCliStore } from '../../store/index.js';
import { SESSION_ENDED_MESSAGE, wrapToolWithPermission } from './gateway.js';
import { ToolCatalog } from './toolCatalog.js';
import { executeWithFuzzyConfirmation } from './stages/fuzzyEdit.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

function tool(name: string, toolFn: (args: unknown) => Promise<string>): ICompletionOptionTools {
  return {
    toolFn,
    toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
  };
}

const apiClient = {} as ApiClient;
afterEach(() => {
  useCliStore.getState().setInteractionMode('normal');
});

describe('retired session execution', () => {
  it('does not run after an allow-always trust save outlives its session', async () => {
    const save = deferred();
    let ended = false;
    const trustTool = vi.fn(async () => save.promise);
    const original = vi.fn(async () => 'ran');
    const wrapped = wrapToolWithPermission(tool('file_read', original), {
      permissionManager: new PermissionManager(new ToolCatalog(), [], []),
      showPermissionPrompt: async () => ({ action: 'allow-always' }),
      agentContext: { currentAgent: null },
      configStore: { getProjectConfigDir: () => null, trustTool },
      apiClient,
      isCancelled: () => ended,
    });
    const running = wrapped.toolFn({ message: 'change' });
    await vi.waitFor(() => expect(trustTool).toHaveBeenCalledOnce());
    ended = true;
    save.resolve();
    expect(await running).toBe(SESSION_ENDED_MESSAGE);
    expect(original).not.toHaveBeenCalled();
  });

  it('does not write after checkpoint persistence outlives its session', async () => {
    const checkpoint = deferred();
    let ended = false;
    const createCheckpoint = vi.fn(async () => checkpoint.promise);
    const original = vi.fn(async () => 'File created successfully: /tmp/retired-session.txt');
    const changed = vi.fn();
    const manager = new PermissionManager(new ToolCatalog(), [], []);
    manager.trustToolForSession('create_file');
    const wrapped = wrapToolWithPermission(tool('create_file', original), {
      permissionManager: manager,
      showPermissionPrompt: async () => ({ action: 'allow-once' }),
      agentContext: { currentAgent: null, onFileChanged: changed },
      configStore: {},
      apiClient,
      checkpointStore: { createCheckpoint } as unknown as CheckpointStore,
      isCancelled: () => ended,
    });
    const running = wrapped.toolFn({ path: '/tmp/retired-session.txt', content: 'old session' });
    await vi.waitFor(() => expect(createCheckpoint).toHaveBeenCalledOnce());
    ended = true;
    checkpoint.resolve();
    expect(await running).toBe(SESSION_ENDED_MESSAGE);
    expect(original).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not retry after directory-grant persistence outlives its session', async () => {
    const save = deferred();
    let ended = false;
    const addDirectory = vi.fn(async () => save.promise);
    const original = vi.fn(async () => 'Access denied: Cannot read files outside allowed directories.');
    const manager = new PermissionManager(new ToolCatalog(), [], []);
    manager.trustToolForSession('file_read');
    const wrapped = wrapToolWithPermission(tool('file_read', original), {
      permissionManager: manager,
      showPermissionPrompt: async () => ({ action: 'allow-always' }),
      agentContext: { currentAgent: null },
      configStore: { addDirectory },
      apiClient,
      allowedDirectories: [],
      isCancelled: () => ended,
    });
    const running = wrapped.toolFn({ path: '/tmp/retired-session.txt' });
    await vi.waitFor(() => expect(addDirectory).toHaveBeenCalledOnce());
    ended = true;
    save.resolve();
    expect(await running).toBe(SESSION_ENDED_MESSAGE);
    expect(original).toHaveBeenCalledOnce();
  });

  it('does not apply a fuzzy edit confirmed after its session ended', async () => {
    const answer = deferred();
    let ended = false;
    const original = vi.fn(async () => {
      throw new FuzzyEditConfirmationRequiredError('/tmp/file.txt', 'snapshot', 'diff');
    });
    const prompt = vi.fn(async () => {
      await answer.promise;
      return { action: 'allow-once' as const };
    });
    const running = executeWithFuzzyConfirmation('edit_local_file', {}, apiClient, original, prompt, () => ended);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    ended = true;
    answer.resolve();
    expect(await running).toBe(SESSION_ENDED_MESSAGE);
    expect(original).toHaveBeenCalledOnce();
  });

  it('does not report a completed old write to the replacement session diagnostics', async () => {
    const finish = deferred();
    let ended = false;
    const original = vi.fn(async () => {
      await finish.promise;
      return 'File created successfully: /tmp/retired-session.txt';
    });
    const changed = vi.fn();
    const manager = new PermissionManager(new ToolCatalog(), [], []);
    manager.trustToolForSession('create_file');
    const wrapped = wrapToolWithPermission(tool('create_file', original), {
      permissionManager: manager,
      showPermissionPrompt: async () => ({ action: 'allow-once' }),
      agentContext: { currentAgent: null, onFileChanged: changed },
      configStore: {},
      apiClient,
      isCancelled: () => ended,
    });
    const running = wrapped.toolFn({ path: '/tmp/retired-session.txt', content: 'old' });
    await vi.waitFor(() => expect(original).toHaveBeenCalledOnce());
    ended = true;
    finish.resolve();
    expect(await running).toBe(SESSION_ENDED_MESSAGE);
    expect(changed).not.toHaveBeenCalled();
  });
});

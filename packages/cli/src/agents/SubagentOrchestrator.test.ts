import { describe, it, expect, vi } from 'vitest';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';
import { SubagentOrchestrator, type OrchestratorDependencies, type SpawnAgentOptions } from './SubagentOrchestrator.js';
import { MAX_SUBAGENT_DEPTH, type AgentHooks } from './types.js';
import { AgentHistoryStore } from './AgentHistoryStore.js';
import { createResumeAgentTool } from './resumeAgentTool.js';
import { PermissionManager } from '../utils/PermissionManager.js';
import { runShellCommand } from '../utils/shellRunner.js';
import { createSkillTool } from '../tools/skillTool.js';
import { buildSkillsPromptSection } from '../core/skillsPrompt.js';
import { generateCliTools } from '../utils/toolsAdapter.js';
import { DEFAULT_SANDBOX_CONFIG } from '../sandbox/types.js';

// A denied hook must never reach the shell; mock it to observe (and to let the
// allow path complete without spawning a real process).
vi.mock('../utils/shellRunner.js', () => ({ runShellCommand: vi.fn() }));

// Spy on the skill-tool factory so a test can assert the orchestrator threads the
// permission collaborators into it (keeps the real implementation).
vi.mock('../tools/skillTool.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../tools/skillTool.js')>();
  return { ...actual, createSkillTool: vi.fn(actual.createSkillTool) };
});

// Spy on the skills-prompt builder so a test can assert WHICH command set the
// orchestrator advertises (model-reachable, not the raw getAllCommands set).
vi.mock('../core/skillsPrompt.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../core/skillsPrompt.js')>();
  return { ...actual, buildSkillsPromptSection: vi.fn(actual.buildSkillsPromptSection) };
});

// Stub tool generation so a real run needs no live apiClient/permission wiring.
// The depth-cap tests below never reach this call (they throw at the agent
// lookup first), so the stub only affects the capture test.
vi.mock('../utils/toolsAdapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/toolsAdapter.js')>();
  return {
    ...actual,
    generateCliTools: vi.fn(async (...args: unknown[]) => ({ tools: [], agentContext: args[5] })),
  };
});

/**
 * Minimal dependency stub. The depth guard runs before any dependency is
 * touched, so an empty agent store is enough to exercise the boundary: a spawn
 * that clears the guard falls through to the "Unknown agent" lookup error.
 */
function createOrchestrator(): SubagentOrchestrator {
  const deps = {
    agentStore: {
      getAgent: () => undefined,
      getAgentNames: () => [],
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    configStore: { get: async () => ({}) },
  } as unknown as OrchestratorDependencies;
  return new SubagentOrchestrator(deps);
}

describe('SubagentOrchestrator depth cap', () => {
  it('rejects a spawn at MAX_SUBAGENT_DEPTH before touching dependencies', async () => {
    const orchestrator = createOrchestrator();
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
        depth: MAX_SUBAGENT_DEPTH,
      })
    ).rejects.toThrow(/nesting depth .* reached the limit/);
  });

  it('rejects a spawn above MAX_SUBAGENT_DEPTH', async () => {
    const orchestrator = createOrchestrator();
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
        depth: MAX_SUBAGENT_DEPTH + 5,
      })
    ).rejects.toThrow(/reached the limit/);
  });

  it('lets a spawn just below the cap through the depth guard', async () => {
    const orchestrator = createOrchestrator();
    // Clears the depth guard, then fails on the (stubbed) unknown-agent lookup -
    // proving the guard did not reject it.
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
        depth: MAX_SUBAGENT_DEPTH - 1,
      })
    ).rejects.toThrow(/Unknown agent/);
  });

  it('defaults an omitted depth to 1 (a direct child), which is allowed', async () => {
    const orchestrator = createOrchestrator();
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
      })
    ).rejects.toThrow(/Unknown agent/);
  });
});

/** LLM that returns a final answer on its first call, so a run finishes in one iteration. */
function createOneShotLlm(answer: string): ICompletionBackend {
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
    ) => {
      await callback([answer], { inputTokens: 10, outputTokens: 5, toolsUsed: [] });
    },
    pushToolMessages: vi.fn(),
  };
}

/** Inline agent definition (bypasses AgentStore) for a minimal, no-tools run. */
function inlineAgent(): SpawnAgentOptions['agentDefinition'] {
  return {
    description: 'test agent',
    model: 'test-model',
    modelResolved: true,
    systemPrompt: 'You are a test agent.',
    maxIterations: { quick: 1, medium: 1, very_thorough: 1 },
    defaultThoroughness: 'quick',
    retry: { maxRetries: 0, initialDelayMs: 0 },
  };
}

function createRunnableOrchestrator(historyStore: AgentHistoryStore, llm: ICompletionBackend): SubagentOrchestrator {
  const deps = {
    userId: 'test-user',
    llm,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    permissionManager: {},
    showPermissionPrompt: vi.fn(),
    configStore: { get: async () => ({}) },
    apiClient: {},
    agentStore: { getAgent: () => undefined, getAgentNames: () => [] },
    historyStore,
  } as unknown as OrchestratorDependencies;
  return new SubagentOrchestrator(deps);
}

describe('SubagentOrchestrator history capture', () => {
  it('stores the finished conversation and returns a resume id', async () => {
    const historyStore = new AgentHistoryStore();
    const orchestrator = createRunnableOrchestrator(historyStore, createOneShotLlm('done'));

    const result = await orchestrator.delegateToAgent({
      task: 'do the thing',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
    });

    expect(result.resumeId).toMatch(/^sub-/);
    expect(historyStore.has(result.resumeId)).toBe(true);
    const stored = historyStore.get(result.resumeId);
    expect(stored?.agentName).toBe('tester');
    expect(stored?.parentSessionId).toBe('session-1');
    expect(stored?.checkpoint.messages.length).toBeGreaterThan(0);
  });

  it('stores under a caller-supplied resume id and replays previousMessages', async () => {
    const historyStore = new AgentHistoryStore();
    const orchestrator = createRunnableOrchestrator(historyStore, createOneShotLlm('done'));
    const prior: IMessage[] = [{ role: 'user', content: 'earlier context marker' }];

    const result = await orchestrator.delegateToAgent({
      task: 'continue',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
      resumeId: 'bg-1234',
      previousMessages: prior,
    });

    expect(result.resumeId).toBe('bg-1234');
    const stored = historyStore.get('bg-1234');
    // run() builds [system, ...previousMessages, user], so the prior message is replayed at index 1.
    const replayed = stored?.checkpoint.messages.find(m => m.content === 'earlier context marker');
    expect(replayed).toBeDefined();
  });
});

describe('SubagentOrchestrator run lifecycle callbacks', () => {
  /** LLM whose completion always throws, so agent.run() rejects. */
  function createFailingLlm(): ICompletionBackend {
    return {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async () => {
        throw new Error('backend exploded');
      },
      pushToolMessages: vi.fn(),
    };
  }

  it('invokes afterRunCallback on success', async () => {
    const orchestrator = createRunnableOrchestrator(new AgentHistoryStore(), createOneShotLlm('done'));
    const afterRun = vi.fn();
    orchestrator.setAfterRunCallback(afterRun);

    await orchestrator.delegateToAgent({
      task: 'do the thing',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
    });

    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun).toHaveBeenCalledWith(expect.anything(), 'tester');
  });

  it('invokes afterRunCallback when the run fails, so live-usage entries never leak', async () => {
    const orchestrator = createRunnableOrchestrator(new AgentHistoryStore(), createFailingLlm());
    const beforeRun = vi.fn();
    const afterRun = vi.fn();
    orchestrator.setBeforeRunCallback(beforeRun);
    orchestrator.setAfterRunCallback(afterRun);

    await expect(
      orchestrator.delegateToAgent({
        task: 'do the thing',
        agentName: 'tester',
        parentSessionId: 'session-1',
        agentDefinition: inlineAgent(),
      })
    ).rejects.toThrow('backend exploded');

    // The failure path must still pair beforeRun with afterRun - the CLI's
    // wireAgentEvents relies on it to remove the live status-bar entry and
    // fold partial usage into the session rollup.
    expect(beforeRun).toHaveBeenCalledTimes(1);
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun).toHaveBeenCalledWith(beforeRun.mock.calls[0][0], 'tester');
  });
});

describe('SubagentOrchestrator sandbox parity (criterion 4)', () => {
  it('default sandbox config denies the credential dirs a subagent must never read', () => {
    const denied = DEFAULT_SANDBOX_CONFIG.filesystem.deniedPaths;
    // The CLI credential/config stores were added by this work; main lacked them.
    for (const p of ['$HOME/.ssh', '$HOME/.aws', '$HOME/.gnupg', '$HOME/.claude', '$HOME/.bike4mind', '/etc/passwd']) {
      expect(denied).toContain(p);
    }
  });

  it('generates subagent tools with the parent sandbox orchestrator + allow-list, not undefined', async () => {
    vi.mocked(generateCliTools).mockClear();
    const sandboxOrchestrator = { marker: 'real-orchestrator' };
    const additionalDirectories = ['/granted/dir'];
    const deps = {
      userId: 'test-user',
      llm: createOneShotLlm('done'),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      permissionManager: {},
      showPermissionPrompt: vi.fn(),
      configStore: { get: async () => ({}) },
      apiClient: {},
      agentStore: { getAgent: () => undefined, getAgentNames: () => [] },
      historyStore: new AgentHistoryStore(),
      sandboxOrchestrator,
      additionalDirectories,
    } as unknown as OrchestratorDependencies;
    const orchestrator = new SubagentOrchestrator(deps);

    await orchestrator.delegateToAgent({
      task: 'do the thing',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
    });

    expect(generateCliTools).toHaveBeenCalled();
    // Positions 11 (sandboxOrchestrator) and 12 (allowedDirectories) in the
    // generateCliTools call; main passed `undefined` for both, so subagent
    // bash_execute ran unsandboxed.
    const calls = vi.mocked(generateCliTools).mock.calls;
    const args = calls[calls.length - 1];
    expect(args[11]).toBe(sandboxOrchestrator);
    expect(args[12]).toBe(additionalDirectories);
  });
});

describe('resume_agent end-to-end through the real orchestrator', () => {
  it('a delegated session, resumed via the tool, replays its prior conversation into the new run', async () => {
    // Records the messages the LLM sees on each call, so we can prove the
    // resumed run received the first run's conversation.
    const seenPerCall: string[][] = [];
    const recordingLlm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (
        _model: string,
        messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
      ) => {
        seenPerCall.push(messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
        await callback(['acknowledged'], { inputTokens: 10, outputTokens: 5, toolsUsed: [] });
      },
      pushToolMessages: vi.fn(),
    };

    const historyStore = new AgentHistoryStore();
    const orchestrator = createRunnableOrchestrator(historyStore, recordingLlm);
    const resumeTool = createResumeAgentTool(orchestrator, historyStore);

    // 1. Delegate an initial task.
    const first = await orchestrator.delegateToAgent({
      task: 'investigate the login bug',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
    });
    expect(historyStore.has(first.resumeId)).toBe(true);

    // 2. Resume it with a follow-up via the tool.
    seenPerCall.length = 0;
    const out = (await resumeTool.toolFn({ job_id: first.resumeId, task: 'now write the fix' })) as string;

    // 3. The resumed run's messages must carry the original task AND the follow-up,
    //    proving prior context was injected (and not double-counting a system prompt).
    expect(seenPerCall.length).toBeGreaterThan(0);
    const resumedMessages = seenPerCall[0];
    expect(resumedMessages.some(c => c.includes('investigate the login bug'))).toBe(true);
    expect(resumedMessages.some(c => c.includes('now write the fix'))).toBe(true);
    // The agent's own prior answer is replayed too, so the resumed run can act on
    // what it previously concluded (final answers are captured as assistant turns).
    expect(resumedMessages.filter(c => c === 'acknowledged').length).toBe(1);
    expect(resumedMessages.filter(c => c.startsWith('You are a test agent.')).length).toBe(1);
    expect(out).toContain('acknowledged');
  });
});

describe('SubagentOrchestrator hook-permission wiring', () => {
  /** Orchestrator whose Stop-hook permission prompt returns `action`. */
  function createHookOrchestrator(action: 'deny' | 'allow-once', customCommandStore?: unknown) {
    const showPermissionPrompt = vi.fn(async () => ({ action }) as { action: 'deny' | 'allow-once' });
    const deps = {
      userId: 'test-user',
      llm: createOneShotLlm('done'),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      permissionManager: new PermissionManager(),
      showPermissionPrompt,
      configStore: { get: async () => ({}) },
      apiClient: {},
      agentStore: { getAgent: () => undefined, getAgentNames: () => [] },
      historyStore: new AgentHistoryStore(),
      customCommandStore,
    } as unknown as OrchestratorDependencies;
    return { orchestrator: new SubagentOrchestrator(deps), showPermissionPrompt };
  }

  function agentWithStopHook(): SpawnAgentOptions['agentDefinition'] {
    const hooks: AgentHooks = { Stop: [{ hooks: [{ type: 'command', command: 'echo pwned' }] }] };
    // inlineAgent() is typed `| undefined` (the field is optional), so spreading
    // it bare widens the required fields; assert non-null to keep them.
    return { ...inlineAgent()!, hooks };
  }

  it('does not run a Stop-hook shell command when the permission prompt denies', async () => {
    // Reverting the orchestrator's permission arg (or toolsAdapter's) to undefined
    // disables this gate; here the denied prompt must keep the shell from running.
    const { orchestrator, showPermissionPrompt } = createHookOrchestrator('deny');
    await orchestrator.delegateToAgent({
      task: 'do it',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: agentWithStopHook(),
    });

    expect(showPermissionPrompt).toHaveBeenCalledWith('agent_hook:Stop', expect.anything(), expect.anything());
    expect(vi.mocked(runShellCommand)).not.toHaveBeenCalled();
  });

  it('runs a Stop-hook shell command when the permission prompt allows', async () => {
    vi.mocked(runShellCommand).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    const { orchestrator } = createHookOrchestrator('allow-once');
    await orchestrator.delegateToAgent({
      task: 'do it',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: agentWithStopHook(),
    });

    expect(vi.mocked(runShellCommand)).toHaveBeenCalledTimes(1);
  });

  it('threads the permission collaborators into the embedded skill tool', async () => {
    vi.mocked(createSkillTool).mockClear();
    const store = { getModelReachableCommands: () => [], getAllCommands: () => [] };
    const { orchestrator } = createHookOrchestrator('allow-once', store);
    await orchestrator.delegateToAgent({
      task: 'do it',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
    });

    expect(createSkillTool).toHaveBeenCalledTimes(1);
    const deps = vi.mocked(createSkillTool).mock.calls[0][0];
    expect(deps.permission.permissionManager).toBeDefined();
    expect(deps.permission.promptFn).toBeDefined();
  });

  it('advertises the model-reachable command set (not getAllCommands) in the skills prompt', async () => {
    vi.mocked(buildSkillsPromptSection).mockClear();
    // Distinct returns from the two accessors. Reverting SubagentOrchestrator's
    // getModelReachableCommands() to getAllCommands() would feed `all` - which
    // carries a reserved-named shadow the dispatch chokepoint refuses - into the
    // prompt instead of `reachable`, so this fails.
    const reachable = [{ name: 'reachable', description: 'ok', body: 'b', source: 'project', filePath: '/p/r.md' }];
    const all = [{ name: 'shadow', description: 'x', body: 'b', source: 'project', filePath: '/p/s.md' }, ...reachable];
    const store = { getModelReachableCommands: () => reachable, getAllCommands: () => all };
    const { orchestrator } = createHookOrchestrator('allow-once', store);

    await orchestrator.delegateToAgent({
      task: 'do it',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
    });

    expect(buildSkillsPromptSection).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildSkillsPromptSection).mock.calls[0][0]).toBe(reachable);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import { promises as fs, existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import type { ApiClient } from '../auth/ApiClient.js';
import type { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import { ToolCatalog } from '../tools/gateway/toolCatalog.js';
import { PermissionManager } from '../utils/PermissionManager.js';
import { generateCliTools } from '../utils/toolsAdapter.js';
import { createHeadlessPromptFn } from './headlessPermissionPrompt.js';
import { parsePermissionPolicy, type HeadlessEvent } from './headlessProtocol.js';

const ALLOW_BASH = parsePermissionPolicy(JSON.stringify({ allow: ['bash_execute'], maxAutoAllowRisk: 'high' }));

function headlessPrompt(catalog: ToolCatalog) {
  const events: HeadlessEvent[] = [];
  const promptFn = createHeadlessPromptFn({
    catalog,
    dangerouslySkipPermissions: false,
    permissionPolicy: ALLOW_BASH,
    emit: event => events.push(event),
    warn: () => {},
  });
  return { promptFn, events };
}

describe('createHeadlessPromptFn', () => {
  it('lets a policy allow-list approve the tool call but never a sandbox escalation', async () => {
    const { promptFn, events } = headlessPrompt(new ToolCatalog());

    await expect(promptFn('bash_execute', { command: 'ls' }, undefined, 'tool')).resolves.toEqual({
      action: 'allow-once',
    });
    await expect(promptFn('bash_execute', { command: 'ls' }, undefined, 'sandbox-escalation')).resolves.toEqual({
      action: 'deny',
    });
    expect(events.filter(event => event.type === 'permission_request').map(event => event.kind)).toEqual([
      'tool',
      'sandbox-escalation',
    ]);
    // The decision echoes its request's kind, so a consumer can pair them by identity, not order.
    expect(events.filter(event => event.type === 'permission_decision').map(event => event.kind)).toEqual([
      'tool',
      'sandbox-escalation',
    ]);
  });

  it('does not point a denied escalation at --permission-policy, which cannot grant it', async () => {
    const warnings: string[] = [];
    const promptFn = createHeadlessPromptFn({
      catalog: new ToolCatalog(),
      dangerouslySkipPermissions: false,
      permissionPolicy: ALLOW_BASH,
      emit: null,
      warn: message => warnings.push(message),
    });

    await expect(promptFn('bash_execute', { command: 'ls' }, undefined, 'sandbox-escalation')).resolves.toEqual({
      action: 'deny',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('outside the sandbox');
    expect(warnings[0]).not.toContain('--permission-policy');
  });
});

describe('headless tool path: sandbox escalation', () => {
  let dir: string;

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Guards the 4th prompt argument end to end: if any wrapper between generateCliTools and the
  // headless prompt dropped `kind`, the escalation would read as a plain bash_execute prompt,
  // the allow-list would approve it, and the unsandboxed retry would create the file.
  it('denies the unsandboxed retry even though the policy allows bash_execute', async () => {
    dir = realpathSync(await fs.mkdtemp(path.join(tmpdir(), 'b4m-headless-esc-')));
    const escaped = path.join(dir, 'escaped');
    const sandboxOrchestrator = {
      shouldSandbox: vi.fn(() => ({
        type: 'sandbox',
        wrappedCommand: {
          commandString: `printf 'touch: ${escaped}: Operation not permitted\\n' >&2; exit 1`,
          cleanupPaths: [],
        },
      })),
      getConfig: () => ({ allowUnsandboxedCommands: true }),
      recordSandboxed: vi.fn(),
      recordUnsandboxed: vi.fn(),
      recordBlocked: vi.fn(),
      recordViolation: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxOrchestrator;
    const permissionManager = new PermissionManager(new ToolCatalog(), [], []);
    const { promptFn, events } = headlessPrompt(permissionManager.catalog);

    const { tools } = await generateCliTools(
      'user-1',
      {} as never, // llm: not exercised by bash_execute
      'test-model',
      permissionManager,
      promptFn,
      { currentAgent: null },
      {} as ConfigStore,
      {} as ApiClient,
      undefined, // toolFilter
      undefined, // showUserQuestion
      null, // checkpointStore
      sandboxOrchestrator,
      [dir]
    );
    const bash = tools.find(tool => tool.toolSchema.name === 'bash_execute');
    expect(bash).toBeDefined();

    const result = await bash!.toolFn({ command: `touch ${escaped}`, cwd: dir });

    expect(String(result)).toContain('Operation not permitted');
    expect(existsSync(escaped)).toBe(false);
    expect(sandboxOrchestrator.recordUnsandboxed).not.toHaveBeenCalled();
    const decisions = events.filter(event => event.type === 'permission_decision').map(event => event.action);
    const kinds = events.filter(event => event.type === 'permission_request').map(event => event.kind);
    expect(kinds).toEqual(['tool', 'sandbox-escalation']);
    expect(decisions).toEqual(['allow-once', 'deny']);
  });
});

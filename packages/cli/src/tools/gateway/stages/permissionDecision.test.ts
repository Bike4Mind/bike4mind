import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { promises as fs, existsSync } from 'fs';
import { tmpdir } from 'os';
import { ConfigStore } from '../../../storage/ConfigStore.js';
import { PermissionManager } from '../../../utils/PermissionManager.js';
import { ToolCatalog } from '../toolCatalog.js';
import { applyPromptResponse, canRunWithoutPrompt, persistToolTrust } from './permissionDecision.js';
import { __resetHostAllowlistCacheForTests } from './hostAllowlist.js';

describe('persistToolTrust (folder-trust gate)', () => {
  let base: string;
  let projectDir: string;
  let globalConfigPath: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    base = await fs.mkdtemp(path.join(tmpdir(), 'b4m-persist-trust-'));
    projectDir = path.join(base, 'proj');
    await fs.mkdir(path.join(projectDir, '.git'), { recursive: true }); // findProjectConfigDir marker
    globalConfigPath = path.join(base, 'global', 'config.json');
    await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
    process.chdir(projectDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it('falls back to global (and writes no repo file) in an untrusted folder', async () => {
    const store = new ConfigStore(globalConfigPath);
    await store.load(); // untrusted is the default
    const pm = new PermissionManager(new ToolCatalog());

    await persistToolTrust('file_read', pm, store);

    // No .bike4mind/ dropped into the repo the user never trusted.
    expect(existsSync(path.join(projectDir, '.bike4mind'))).toBe(false);

    // The decision is honored on next launch: it landed in the global layer.
    const reloaded = await new ConfigStore(globalConfigPath).load();
    expect(reloaded.trustedTools).toContain('file_read');
    const pmReloaded = new PermissionManager(new ToolCatalog(), reloaded.trustedTools);
    expect(pmReloaded.needsPermission('file_read')).toBe(false);
  });

  it('persists to project-local when the folder IS trusted', async () => {
    const store = new ConfigStore(globalConfigPath);
    await store.load();
    expect(await store.trustProject()).toBe(true);
    const pm = new PermissionManager(new ToolCatalog());

    await persistToolTrust('file_read', pm, store);

    const localRaw = JSON.parse(await fs.readFile(path.join(projectDir, '.bike4mind', 'local.json'), 'utf-8'));
    expect(localRaw.trustedTools).toContain('file_read');
    // Trusted-path persistence must NOT also write it to the global layer.
    const reloadedGlobal = JSON.parse(await fs.readFile(globalConfigPath, 'utf-8'));
    expect(reloadedGlobal.trustedTools ?? []).not.toContain('file_read');
  });
});

describe('canRunWithoutPrompt', () => {
  const base = {
    toolName: 'file_read',
    isMcpTool: false,
    forcePrompt: false,
    isSandboxed: false,
    interactionMode: 'normal' as const,
  };

  it('runs a tool that needs no permission', () => {
    const permissionManager = new PermissionManager(new ToolCatalog());
    expect(canRunWithoutPrompt({ ...base, toolName: 'math_evaluate', permissionManager })).toBe(true);
  });

  it('prompts for a tool that needs permission in normal mode', () => {
    const permissionManager = new PermissionManager(new ToolCatalog());
    expect(canRunWithoutPrompt({ ...base, permissionManager })).toBe(false);
  });

  it('runs a trusted tool and anything in auto-accept mode', () => {
    expect(
      canRunWithoutPrompt({ ...base, permissionManager: new PermissionManager(new ToolCatalog(), ['file_read']) })
    ).toBe(true);
    expect(
      canRunWithoutPrompt({
        ...base,
        toolName: 'bash_execute',
        interactionMode: 'auto-accept',
        permissionManager: new PermissionManager(new ToolCatalog()),
      })
    ).toBe(true);
  });

  it('prompts whenever a gate forced it, even for an auto-approved tool in auto-accept mode', () => {
    expect(
      canRunWithoutPrompt({
        ...base,
        toolName: 'math_evaluate',
        forcePrompt: true,
        interactionMode: 'auto-accept',
        permissionManager: new PermissionManager(new ToolCatalog()),
      })
    ).toBe(false);
  });
});

describe('canRunWithoutPrompt with a host allowlist (claude --allowedTools)', () => {
  const original = process.env.B4M_ALLOWED_TOOLS;
  const base = { isMcpTool: false, forcePrompt: false, isSandboxed: false, interactionMode: 'normal' as const };

  beforeEach(() => {
    process.env.B4M_ALLOWED_TOOLS = JSON.stringify(['mcp__host__*']);
    __resetHostAllowlistCacheForTests();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.B4M_ALLOWED_TOOLS;
    else process.env.B4M_ALLOWED_TOOLS = original;
    __resetHostAllowlistCacheForTests();
  });

  it('runs an MCP tool the claude-form pattern names, without a prompt', () => {
    const permissionManager = new PermissionManager(new ToolCatalog());
    expect(canRunWithoutPrompt({ ...base, toolName: 'host__read_self', isMcpTool: true, permissionManager })).toBe(
      true
    );
  });

  it('still prompts for a built-in and for another server', () => {
    const permissionManager = new PermissionManager(new ToolCatalog());
    expect(canRunWithoutPrompt({ ...base, toolName: 'bash_execute', permissionManager })).toBe(false);
    expect(canRunWithoutPrompt({ ...base, toolName: 'github__create_issue', isMcpTool: true, permissionManager })).toBe(
      false
    );
  });

  it('a forced prompt still wins over the allowlist', () => {
    const permissionManager = new PermissionManager(new ToolCatalog());
    expect(
      canRunWithoutPrompt({
        ...base,
        toolName: 'host__read_self',
        isMcpTool: true,
        forcePrompt: true,
        permissionManager,
      })
    ).toBe(false);
  });
});

describe('applyPromptResponse', () => {
  it('throws on deny', async () => {
    const permissionManager = new PermissionManager(new ToolCatalog());
    await expect(applyPromptResponse('file_read', {}, 'deny', permissionManager, {})).rejects.toThrow();
  });

  it('trusts the tool for the session on allow-session', async () => {
    const permissionManager = new PermissionManager(new ToolCatalog());
    await applyPromptResponse('file_read', {}, 'allow-session', permissionManager, {});
    expect(permissionManager.needsPermission('file_read')).toBe(false);
  });

  it('persists trust on allow-always and leaves allow-once without side effects', async () => {
    const permissionManager = new PermissionManager(new ToolCatalog());
    const configStore = { getProjectConfigDir: () => null, trustTool: vi.fn() };
    await applyPromptResponse('file_read', {}, 'allow-once', permissionManager, configStore);
    expect(configStore.trustTool).not.toHaveBeenCalled();
    expect(permissionManager.needsPermission('file_read')).toBe(true);
    await applyPromptResponse('file_read', {}, 'allow-always', permissionManager, configStore);
    expect(configStore.trustTool).toHaveBeenCalledWith('file_read');
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessStore } from '../tools/AccessStore';
import { PermissionRuleStore } from '../permissions/PermissionRuleStore';
import { PermissionService } from '../permissions/PermissionService';
import { ClaudeCodeSettings } from '../permissions/ClaudeCodeSettings';
import { CapabilityLedger } from './CapabilityLedger';
import {
  capabilityHandlers,
  completeCapabilityMutation,
  retireSessionApprovals,
  syncCapabilityChange,
} from './capabilityHandlers';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'capability-handler-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function setup() {
  const ledger = new CapabilityLedger(join(directory, 'ledger.json'));
  let account: string | null = 'account-a';
  const targets = {
    approvals: { revoke: vi.fn().mockReturnValue(true) },
    removeSessionDirectory: vi.fn().mockResolvedValue(true),
    revokeRoot: vi.fn().mockResolvedValue(true),
    untrustProject: vi.fn().mockResolvedValue(true),
    revokeAllow: vi.fn().mockResolvedValue(true),
  };
  const sessions = vi.fn(async () => []);
  const handlers = capabilityHandlers({
    ledger,
    ready: Promise.resolve(),
    scopeKey: () => account,
    sessions,
    targets,
  });
  return {
    ledger,
    targets,
    handlers,
    sessions,
    switchAccount: (next: string | null) => {
      account = next;
    },
  };
}

const sessionGrant = (scopeKey: string) => ({
  subject: { kind: 'session' as const, sessionId: 'session', scopeKey },
  capability: 'files' as const,
  scope: { kind: 'path' as const, value: '/work/private' },
  source: 'folder-picker' as const,
});

describe('capability IPC handlers', () => {
  it('does not expose or revoke conversation folders from another account', async () => {
    const { ledger, targets, handlers, switchAccount } = setup();
    const grant = await ledger.grant(sessionGrant('account-a'));
    expect((await handlers.getState()).grants).toHaveLength(1);
    switchAccount('account-b');
    const state = await handlers.getState();
    expect(state.grants).toEqual([]);
    expect(state.audit).toEqual([]);
    await expect(handlers.revoke(grant.id)).rejects.toThrow();
    expect(targets.removeSessionDirectory).not.toHaveBeenCalled();
    switchAccount('account-a');
    expect((await handlers.getState()).grants[0]?.revokedAt).toBeUndefined();
    switchAccount(null);
    expect((await handlers.getState()).grants).toEqual([]);
  });

  it('rejects session enumeration failures rather than reporting an empty account', async () => {
    const { handlers, sessions } = setup();
    sessions.mockRejectedValue(new Error('session disk unavailable'));
    await expect(handlers.getState()).rejects.toThrow('session disk unavailable');
  });

  it('does not migrate sessions when the account changes during enumeration', async () => {
    const { ledger, handlers, sessions, switchAccount } = setup();
    const migrate = vi.spyOn(ledger, 'migrate');
    sessions.mockImplementation(async () => {
      switchAccount('account-b');
      return [];
    });
    await expect(handlers.getState()).rejects.toThrow('Account changed');
    expect(migrate).not.toHaveBeenCalled();
  });

  it('rejects a missing-session revoke and leaves the grant and audit intact', async () => {
    const { ledger, targets, handlers } = setup();
    const grant = await ledger.grant(sessionGrant('account-a'));
    targets.removeSessionDirectory.mockResolvedValue(false);
    await expect(handlers.revoke(grant.id)).rejects.toThrow();
    const state = await handlers.getState();
    expect(state.grants[0]?.revokedAt).toBeUndefined();
    expect(state.audit.map(event => event.type)).toEqual(['grant']);
  });

  it('records revocation only when enforcement removed access', async () => {
    const { ledger, handlers, targets } = setup();
    const grant = await ledger.grant(sessionGrant('account-a'));
    const state = await handlers.revoke(grant.id);
    expect(targets.removeSessionDirectory).toHaveBeenCalledWith('session', '/work/private');
    expect(state.grants[0]?.revokedAt).toBeDefined();
    expect(state.audit.map(event => event.type)).toEqual(['revoke', 'grant']);
  });

  it('retires in-memory approvals at startup once while retaining conversation paths', async () => {
    const { ledger } = setup();
    await ledger.grant(sessionGrant('account-a'));
    await ledger.grant({
      ...sessionGrant('account-a'),
      capability: 'tool',
      scope: { kind: 'tool', value: 'bash_execute' },
    });
    await retireSessionApprovals(ledger);
    await retireSessionApprovals(ledger);
    const state = await ledger.state();
    expect(state.grants.find(grant => grant.scope.kind === 'path')?.revokedAt).toBeUndefined();
    expect(state.grants.find(grant => grant.scope.kind === 'tool')?.revokedAt).toBeDefined();
    expect(state.audit.filter(event => event.type === 'revoke')).toHaveLength(1);
  });
});

describe('post-mutation capability synchronization', () => {
  it.each(['permission save', 'folder grant', 'folder revoke'])(
    'logs failed audit sync after a successful %s',
    async () => {
      const logger = { warn: vi.fn() };
      const sync = vi.fn().mockRejectedValue(new Error('ledger is unreadable'));
      await expect(syncCapabilityChange(sync, logger)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ledger is unreadable'));
    }
  );
});

describe('committed permission results survive audit failures', () => {
  it('returns saved rules and settles approvals despite a failed ledger sync', async () => {
    const logger = { warn: vi.fn() };
    const ledgerPath = join(directory, 'ledger.json');
    await writeFile(ledgerPath, 'garbage');
    const ledger = new CapabilityLedger(ledgerPath);
    const claudeCode = new ClaudeCodeSettings({
      home: directory,
      managedPath: join(directory, 'managed.json'),
      logger,
      onChange: () => {},
    });
    const permissionStore = new PermissionRuleStore(join(directory, 'rules.json'));
    const permissions = new PermissionService({
      store: permissionStore,
      claudeCode,
      home: directory,
      protectedRoots: [],
      isTrusted: async () => false,
      logger,
    });
    const settleCovered = vi.fn();
    try {
      // An unreadable ledger at startup must also recover before the mutation is attempted.
      await ledger.state();
      vi.spyOn(ledger, 'revokeMatching').mockRejectedValue(new Error('audit disk full'));
      const committed = await permissions.setRules({ kind: 'user' }, { allow: ['Bash(pwd)'], ask: [], deny: [] });
      const result = await completeCapabilityMutation(
        committed,
        () => ledger.revokeMatching(() => true),
        logger,
        settleCovered
      );
      expect(result.ok).toBe(true);
      expect((await permissionStore.read()).user.allow).toEqual(['Bash(pwd)']);
      expect(settleCovered).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('audit disk full'));
    } finally {
      permissions.dispose();
    }
  });

  it('returns folder picker and revoke results even when a garbage ledger cannot sync', async () => {
    const logger = { warn: vi.fn() };
    const ledgerPath = join(directory, 'ledger.json');
    await writeFile(ledgerPath, 'garbage');
    const ledger = new CapabilityLedger(ledgerPath);
    const access = new AccessStore(join(directory, 'access.json'));
    const root = join(directory, 'picked');
    const roots = await access.grant(root);
    const granted = await completeCapabilityMutation({ roots }, () => ledger.state(), logger);
    expect(granted.roots).toEqual([root]);
    vi.spyOn(ledger, 'revokeMatching').mockRejectedValue(new Error('audit unavailable'));
    const revoked = await completeCapabilityMutation(
      { roots: await access.revoke(root) },
      () => ledger.revokeMatching(() => true),
      logger
    );
    expect(revoked.roots).toEqual([]);
    expect(await access.list()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('audit unavailable'));
  });
});

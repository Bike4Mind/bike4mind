import { describe, expect, it, vi } from 'vitest';
import type { CapabilityGrant } from '@shared/capabilities';
import { ApprovalGate } from '../tools/ApprovalGate';
import { capabilityFor, capabilityScope, enforceRevocation, revokeSessionCapability } from './approvalCapabilities';

describe('approval capabilities', () => {
  it.each([
    ['bash_execute', 'bash-execute:touch made.txt', 'tool'],
    ['generate_image', 'generate-image:portrait', 'credits'],
    ['file_write', 'write:/tmp/notes.txt', 'files'],
  ] as const)('revokes the exact %s approval', async (tool, key, capability) => {
    const gate = new ApprovalGate();
    await gate.request('session', key, new AbortController().signal, id => {
      gate.resolve(id, { decision: 'always', optionId: 'run' });
    });
    expect(capabilityFor(tool, key)).toBe(capability);
    const grant: CapabilityGrant = {
      id: 'grant',
      subject: { kind: 'session', sessionId: 'session' },
      capability,
      scope: capabilityScope(tool, key),
      approvalKey: key,
      createdAt: new Date().toISOString(),
      source: 'approval',
    };
    expect(gate.isStanding('session', key, ['run'])).not.toBeNull();
    revokeSessionCapability(grant, gate);
    expect(gate.isStanding('session', key, ['run'])).toBeNull();
  });

  it.each([
    ['browser-open', 'network', 'browser-origin'],
    ['browser-open-as-you', 'read', 'imported-identity'],
    ['browser-act', 'act', 'browser-origin'],
    ['browser-act-as-you', 'act', 'imported-identity'],
    ['browser-script', 'script', 'browser-origin'],
    ['browser-script-as-you', 'script', 'imported-identity'],
  ] as const)('records and revokes %s consent', async (prefix, access, capability) => {
    const key = `${prefix}:https://example.com`;
    const gate = new ApprovalGate();
    const waiting = gate.request('session', key, new AbortController().signal, id => {
      gate.resolve(id, { decision: 'always' });
    });
    await waiting;
    const scope = capabilityScope('browser_evaluate', key);
    expect(scope).toEqual({ kind: 'browser-origin', value: 'https://example.com', access });
    expect(capabilityFor('browser_evaluate', key)).toBe(capability);
    const grant: CapabilityGrant = {
      id: 'grant',
      subject: { kind: 'session', sessionId: 'session' },
      capability,
      scope,
      approvalKey: key,
      createdAt: new Date().toISOString(),
      source: 'approval',
    };
    expect(gate.isStanding('session', key)).not.toBeNull();
    revokeSessionCapability(grant, gate);
    expect(gate.isStanding('session', key)).toBeNull();
  });

  describe('enforceRevocation', () => {
    const targets = () => ({
      approvals: { revoke: vi.fn() },
      removeSessionDirectory: vi.fn().mockResolvedValue(undefined),
      revokeRoot: vi.fn().mockResolvedValue(undefined),
      untrustProject: vi.fn().mockResolvedValue(undefined),
      revokeAllow: vi.fn().mockResolvedValue(undefined),
    });
    const grant = (fields: Pick<CapabilityGrant, 'subject' | 'capability' | 'scope'> & Partial<CapabilityGrant>) => ({
      id: 'grant',
      createdAt: new Date().toISOString(),
      source: 'migration' as const,
      ...fields,
    });

    it('removes a session folder from that conversation only', async () => {
      const t = targets();
      await enforceRevocation(
        grant({
          subject: { kind: 'session', sessionId: 's1' },
          capability: 'files',
          scope: { kind: 'path', value: '/work/a' },
        }),
        t
      );
      expect(t.removeSessionDirectory).toHaveBeenCalledWith('s1', '/work/a');
      expect(t.revokeRoot).not.toHaveBeenCalled();
    });

    it('revokes a desktop folder root', async () => {
      const t = targets();
      await enforceRevocation(
        grant({ subject: { kind: 'desktop-user' }, capability: 'files', scope: { kind: 'path', value: '/work/a' } }),
        t
      );
      expect(t.revokeRoot).toHaveBeenCalledWith('/work/a');
      expect(t.removeSessionDirectory).not.toHaveBeenCalled();
    });

    it('withdraws project trust', async () => {
      const t = targets();
      await enforceRevocation(
        grant({
          subject: { kind: 'project', directory: '/work/p' },
          capability: 'project-trust',
          scope: { kind: 'project', value: '/work/p' },
        }),
        t
      );
      expect(t.untrustProject).toHaveBeenCalledWith('/work/p');
    });

    it.each([
      [{ kind: 'desktop-user' } as const, { kind: 'user' }],
      [{ kind: 'project', directory: '/work/p' } as const, { kind: 'project', directory: '/work/p' }],
    ])('removes a permission rule from the scope it was saved in', async (subject, scope) => {
      const t = targets();
      await enforceRevocation(
        grant({ subject, capability: 'tool', scope: { kind: 'permission-rule', value: 'Bash(ls:*)' } }),
        t
      );
      expect(t.revokeAllow).toHaveBeenCalledWith(scope, 'Bash(ls:*)');
    });

    it('drops the exact standing approval of a session grant', async () => {
      const t = targets();
      await enforceRevocation(
        grant({
          subject: { kind: 'session', sessionId: 's1' },
          capability: 'tool',
          scope: { kind: 'tool', value: 'bash_execute' },
          approvalKey: 'bash-execute:ls',
        }),
        t
      );
      expect(t.approvals.revoke).toHaveBeenCalledWith('s1', 'bash-execute:ls');
      expect(t.removeSessionDirectory).not.toHaveBeenCalled();
      expect(t.revokeAllow).not.toHaveBeenCalled();
    });

    it('propagates an enforcement failure so the ledger does not record the revoke', async () => {
      const t = targets();
      t.revokeRoot.mockRejectedValue(new Error('disk full'));
      await expect(
        enforceRevocation(
          grant({ subject: { kind: 'desktop-user' }, capability: 'files', scope: { kind: 'path', value: '/a' } }),
          t
        )
      ).rejects.toThrow('disk full');
    });
  });
});

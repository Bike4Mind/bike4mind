import { describe, expect, it } from 'vitest';
import type { CapabilityGrant } from '@shared/capabilities';
import { ApprovalGate } from '../tools/ApprovalGate';
import { capabilityFor, capabilityScope, revokeSessionCapability } from './approvalCapabilities';

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
});

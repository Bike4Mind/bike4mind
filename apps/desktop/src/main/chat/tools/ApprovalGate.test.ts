import { describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from './ApprovalGate';

/**
 * The gate keeps no cross-session view of what is waiting: an approval is answered in the
 * conversation that raised it, and `requested`/`settled` are all the sidebar needs to say a
 * session is blocked.
 */
function ask(gate: ApprovalGate, sessionId: string, key = 'bash:rm') {
  const controller = new AbortController();
  let approvalId = '';
  const answer = gate.request(sessionId, key, controller.signal, id => {
    approvalId = id;
  });
  return { answer, approvalId: () => approvalId, controller };
}

describe('ApprovalGate', () => {
  it('resolves the request its own approvalId answers', async () => {
    const gate = new ApprovalGate();
    const a = ask(gate, 'session-a');
    const b = ask(gate, 'session-b');

    gate.resolve(a.approvalId(), { decision: 'once' });
    gate.resolve(b.approvalId(), { decision: 'deny' });

    await expect(a.answer).resolves.toEqual({ decision: 'once' });
    await expect(b.answer).resolves.toEqual({ decision: 'deny' });
  });

  it('reports the session that is waiting, and that it stopped', async () => {
    const requested = vi.fn();
    const settled = vi.fn();
    const gate = new ApprovalGate({ requested, settled });

    const pending = ask(gate, 'session-a');
    expect(requested).toHaveBeenCalledWith('session-a');
    expect(settled).not.toHaveBeenCalled();

    gate.resolve(pending.approvalId(), { decision: 'once' });
    await pending.answer;
    expect(settled).toHaveBeenCalledWith('session-a');
  });

  it('replays a standing answer only for the session that gave it', async () => {
    const gate = new ApprovalGate();
    const first = ask(gate, 'session-a');
    gate.resolve(first.approvalId(), { decision: 'always' });
    await first.answer;

    expect(gate.isStanding('session-a', 'bash:rm')).toEqual({});
    expect(gate.isStanding('session-b', 'bash:rm')).toBeNull();
  });

  it('offers no way to list what other conversations are waiting on', () => {
    const gate = new ApprovalGate() as unknown as Record<string, unknown>;
    expect(gate.pendingApprovals).toBeUndefined();
  });
});

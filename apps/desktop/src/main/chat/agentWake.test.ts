import { describe, expect, it } from 'vitest';
import {
  AgentWakeLedger,
  agentsSettledNotice,
  agentsSettledSummary,
  MAX_AGENT_WAKES_PER_PARENT,
  type SettledAgent,
} from './agentWake';

const agent = (sessionId: string, overrides: Partial<SettledAgent> = {}): SettledAgent => ({
  sessionId,
  title: `Agent ${sessionId}`,
  outcome: 'finished',
  lastReply: `did ${sessionId}`,
  ...overrides,
});

describe('AgentWakeLedger', () => {
  it('hands the whole batch to one claim, and nothing to a second', () => {
    const ledger = new AgentWakeLedger();
    ledger.record('p', agent('a'));
    ledger.record('p', agent('b'));

    const first = ledger.claim('p');
    expect(first).toEqual({ ok: true, agents: [agent('a'), agent('b')] });
    expect(ledger.claim('p')).toEqual({ ok: false, reason: 'waking' });
    ledger.finish('p', true, first.ok ? first.agents : []);
    expect(ledger.claim('p')).toEqual({ ok: false, reason: 'none' });
  });

  it('keeps only the latest turn of an agent that ran twice', () => {
    const ledger = new AgentWakeLedger();
    ledger.record('p', agent('a', { lastReply: 'first' }));
    ledger.record('p', agent('a', { lastReply: 'second' }));

    expect(ledger.claim('p')).toEqual({ ok: true, agents: [agent('a', { lastReply: 'second' })] });
  });

  it('stops waking a parent at the cap, whatever is recorded after it', () => {
    const ledger = new AgentWakeLedger();
    for (let wake = 0; wake < MAX_AGENT_WAKES_PER_PARENT; wake++) {
      ledger.record('p', agent('a'));
      const claim = ledger.claim('p');
      expect(claim.ok).toBe(true);
      ledger.finish('p', true, claim.ok ? claim.agents : []);
    }

    ledger.record('p', agent('a'));
    expect(ledger.claim('p')).toEqual({ ok: false, reason: 'cap' });
    expect(ledger.hasPending('p')).toBe(false);
  });

  it('gives back the count and the batch when the wake could not start', () => {
    const ledger = new AgentWakeLedger();
    for (let wake = 0; wake < MAX_AGENT_WAKES_PER_PARENT - 1; wake++) {
      ledger.record('p', agent('a'));
      const claim = ledger.claim('p');
      ledger.finish('p', true, claim.ok ? claim.agents : []);
    }
    ledger.record('p', agent('a'));
    const refused = ledger.claim('p');
    ledger.record('p', agent('b'));
    ledger.finish('p', false, refused.ok ? refused.agents : []);

    expect(ledger.claim('p')).toEqual({ ok: true, agents: [agent('b'), agent('a')] });
  });

  it('wakes a stopped parent for nothing until it is released', () => {
    const ledger = new AgentWakeLedger();
    ledger.record('p', agent('a'));
    ledger.hold('p');
    ledger.record('p', agent('b'));

    expect(ledger.claim('p')).toEqual({ ok: false, reason: 'held' });
    ledger.release('p');
    expect(ledger.claim('p')).toEqual({ ok: false, reason: 'none' });
    ledger.record('p', agent('c'));
    expect(ledger.claim('p')).toEqual({ ok: true, agents: [agent('c')] });
  });
});

describe('agentsSettledNotice', () => {
  it('names each agent, how it ended and how its last reply began, then says what to do next', () => {
    const text = agentsSettledNotice([
      agent('a', { title: 'Catalog' }),
      agent('b', { title: 'Overlay', outcome: 'failed', lastReply: null }),
      agent('c', { title: 'Wiring', outcome: 'aborted', lastReply: null }),
    ]);

    expect(text).toContain('This is not the user typing.');
    expect(text).toContain('- "Catalog" (a): done. Its last reply began: "did a"');
    expect(text).toContain('- "Overlay" (b): failed.');
    expect(text).toContain('- "Wiring" (c): stopped.');
    expect(text).toContain('write the final summary for the user now.');
  });

  it('summarises the batch in one line for the thread', () => {
    expect(
      agentsSettledSummary([agent('a'), agent('b', { outcome: 'max-tokens' }), agent('c', { outcome: 'failed' })])
    ).toBe('3 agents: 2 done, 1 failed');
  });
});

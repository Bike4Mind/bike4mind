import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReplSession,
  BudgetExceededError,
  getOrCreateReplSession,
  getReplSession,
  disposeReplSession,
  configureReplSessionRegistry,
  evictIdleReplSessions,
  activeReplSessionCount,
  _resetReplSessionsForTests,
} from './ReplSession';

describe('ReplSession', () => {
  beforeEach(async () => {
    await _resetReplSessionsForTests();
  });

  it('runs code and tracks executions in usage', async () => {
    const session = new ReplSession({ sessionId: 'test-1', executor: 'in-process-unsafe' });
    const r = await session.runCode('console.log("ok");');
    expect(r.stdout).toBe('ok');
    expect(session.getUsage().executions).toBe(1);
  });

  it('persists variables across runCode (delegates to ReplContext)', async () => {
    const session = new ReplSession({ sessionId: 'test-2', executor: 'in-process-unsafe' });
    await session.runCode('counter = 0;');
    await session.runCode('counter += 1;');
    const r = await session.runCode('console.log(counter);');
    expect(r.stdout).toBe('1');
    expect(session.getUsage().executions).toBe(3);
  });

  it('records sub-LLM calls via recordSubLlm()', async () => {
    const session = new ReplSession({ sessionId: 'test-3', executor: 'in-process-unsafe' });
    session.recordSubLlm({ costUsd: 0.001, promptTokens: 100, completionTokens: 50 });
    session.recordSubLlm({ costUsd: 0.002, promptTokens: 200, completionTokens: 80 });
    const u = session.getUsage();
    expect(u.subLlmCalls).toBe(2);
    expect(u.totalCostUsd).toBeCloseTo(0.003, 6);
    expect(u.promptTokens).toBe(300);
    expect(u.completionTokens).toBe(130);
  });

  it('throws BudgetExceededError when execution cap is hit', async () => {
    const session = new ReplSession({
      executor: 'in-process-unsafe',
      sessionId: 'test-4',
      budget: { maxExecutions: 2 },
    });
    await session.runCode('a = 1;');
    await session.runCode('b = 2;');
    await expect(session.runCode('c = 3;')).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('throws BudgetExceededError mid-execution on the recordSubLlm call that tips cost cap', () => {
    const session = new ReplSession({
      executor: 'in-process-unsafe',
      sessionId: 'test-5',
      budget: { maxCostUsd: 0.01 },
    });
    // First call is under cap - accepted silently
    expect(() => session.recordSubLlm({ costUsd: 0.005 })).not.toThrow();
    // Second call tips the budget - throws immediately so the
    // surrounding for-loop in execute_code stops here, not on the
    // next runCode pre-flight check.
    expect(() => session.recordSubLlm({ costUsd: 0.006 })).toThrowError(BudgetExceededError);
  });

  it('next runCode after a mid-execution throw still rejects with BudgetExceededError', async () => {
    const session = new ReplSession({
      executor: 'in-process-unsafe',
      sessionId: 'test-5b',
      budget: { maxCostUsd: 0.01 },
    });
    session.recordSubLlm({ costUsd: 0.005 });
    expect(() => session.recordSubLlm({ costUsd: 0.006 })).toThrowError(BudgetExceededError);
    // Pre-flight on next runCode: budget is still over, still throws.
    await expect(session.runCode('x = 1;')).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('allows exactly maxSubLlmCalls successful records, throws on the (N+1)th', () => {
    // maxSubLlmCalls = N means N successful records complete cleanly; the
    // (N+1)th throws. Uses `>` not `>=` so the cap matches its documented
    // semantics.
    const session = new ReplSession({
      executor: 'in-process-unsafe',
      sessionId: 'test-6a',
      budget: { maxSubLlmCalls: 3 },
    });
    // 3 successful records - none throw
    session.recordSubLlm({ costUsd: 0 });
    session.recordSubLlm({ costUsd: 0 });
    session.recordSubLlm({ costUsd: 0 });
    expect(session.getUsage().subLlmCalls).toBe(3);
    // 4th throws
    expect(() => session.recordSubLlm({ costUsd: 0 })).toThrowError(BudgetExceededError);
  });

  it('budgetReason() reports the binding cap (pre-flight check uses >= so next runCode rejects)', async () => {
    const session = new ReplSession({
      executor: 'in-process-unsafe',
      sessionId: 'test-6b',
      budget: { maxSubLlmCalls: 3 },
    });
    expect(session.budgetReason()).toBeNull();
    session.recordSubLlm({ costUsd: 0 });
    session.recordSubLlm({ costUsd: 0 });
    session.recordSubLlm({ costUsd: 0 });
    // Hit the cap exactly - next runCode would reject pre-flight.
    expect(session.budgetReason()).toContain('sub-LLM calls 3/3');
  });

  describe('session registry', () => {
    it('getOrCreateReplSession reuses an existing session by ID', () => {
      const a = getOrCreateReplSession({ sessionId: 'agent-X', executor: 'in-process-unsafe' });
      const b = getOrCreateReplSession({ sessionId: 'agent-X', executor: 'in-process-unsafe' });
      expect(a).toBe(b);
    });

    it('disposeReplSession evicts the session from the registry', () => {
      getOrCreateReplSession({ sessionId: 'agent-Y', executor: 'in-process-unsafe' });
      expect(getReplSession('agent-Y')).toBeDefined();
      disposeReplSession('agent-Y');
      expect(getReplSession('agent-Y')).toBeUndefined();
    });

    it('a fresh getOrCreate after dispose does NOT inherit prior REPL state', async () => {
      const s1 = getOrCreateReplSession({ sessionId: 'agent-Z', executor: 'in-process-unsafe' });
      await s1.runCode('persisted = "first session";');
      disposeReplSession('agent-Z');

      const s2 = getOrCreateReplSession({ sessionId: 'agent-Z', executor: 'in-process-unsafe' });
      const r = await s2.runCode('console.log(typeof persisted);');
      // Fresh session: `persisted` should be undefined
      expect(r.stdout).toBe('undefined');
    });
  });

  describe('Quest 3a: LRU + TTL eviction', () => {
    it('lastAccessedAt advances on runCode', async () => {
      const s = new ReplSession({ sessionId: 't-touch-1', executor: 'in-process-unsafe' });
      const t0 = s.lastAccessedAt;
      await new Promise(r => setTimeout(r, 5));
      await s.runCode('x = 1;');
      expect(s.lastAccessedAt).toBeGreaterThan(t0);
    });

    it('lastAccessedAt advances on recordSubLlm', async () => {
      const s = new ReplSession({ sessionId: 't-touch-2', executor: 'in-process-unsafe' });
      const t0 = s.lastAccessedAt;
      await new Promise(r => setTimeout(r, 5));
      s.recordSubLlm({ costUsd: 0.001 });
      expect(s.lastAccessedAt).toBeGreaterThan(t0);
    });

    it('explicit touch() advances lastAccessedAt without doing work', async () => {
      const s = new ReplSession({ sessionId: 't-touch-3', executor: 'in-process-unsafe' });
      const t0 = s.lastAccessedAt;
      await new Promise(r => setTimeout(r, 5));
      s.touch();
      expect(s.lastAccessedAt).toBeGreaterThan(t0);
    });

    it('getOrCreateReplSession touches existing session on lookup', async () => {
      const s1 = getOrCreateReplSession({ sessionId: 'lru-touch', executor: 'in-process-unsafe' });
      const t0 = s1.lastAccessedAt;
      await new Promise(r => setTimeout(r, 5));
      const s2 = getOrCreateReplSession({ sessionId: 'lru-touch', executor: 'in-process-unsafe' });
      expect(s2).toBe(s1);
      expect(s2.lastAccessedAt).toBeGreaterThan(t0);
    });

    it('evictIdleReplSessions drops sessions older than idleTtlMs', async () => {
      configureReplSessionRegistry({ idleTtlMs: 50 });
      getOrCreateReplSession({ sessionId: 'idle-1', executor: 'in-process-unsafe' });
      getOrCreateReplSession({ sessionId: 'idle-2', executor: 'in-process-unsafe' });
      expect(activeReplSessionCount()).toBe(2);

      await new Promise(r => setTimeout(r, 80));
      const evicted = evictIdleReplSessions();
      expect(evicted).toBe(2);
      expect(activeReplSessionCount()).toBe(0);
    });

    it('TTL eviction fires automatically on next getOrCreateReplSession', async () => {
      configureReplSessionRegistry({ idleTtlMs: 50 });
      getOrCreateReplSession({ sessionId: 'auto-evict-1', executor: 'in-process-unsafe' });
      await new Promise(r => setTimeout(r, 80));
      // The new session triggers the housekeeping pass
      getOrCreateReplSession({ sessionId: 'auto-evict-2', executor: 'in-process-unsafe' });
      // 'auto-evict-1' should have been TTL-swept
      expect(activeReplSessionCount()).toBe(1);
    });

    it('LRU eviction kicks in when registry hits maxSessions cap', () => {
      configureReplSessionRegistry({ maxSessions: 3, idleTtlMs: 60 * 60 * 1000 });
      const a = getOrCreateReplSession({ sessionId: 'lru-a', executor: 'in-process-unsafe' });
      // Each subsequent create has a strictly later lastAccessedAt thanks
      // to the constructor stamping Date.now() - but to make the test
      // deterministic across fast machines, we explicitly bump.
      a.touch();
      const b = getOrCreateReplSession({ sessionId: 'lru-b', executor: 'in-process-unsafe' });
      b.touch();
      const c = getOrCreateReplSession({ sessionId: 'lru-c', executor: 'in-process-unsafe' });
      c.touch();
      expect(activeReplSessionCount()).toBe(3);

      // Adding a 4th over cap should evict the oldest (lru-a)
      getOrCreateReplSession({ sessionId: 'lru-d', executor: 'in-process-unsafe' });
      expect(activeReplSessionCount()).toBe(3);
      expect(getReplSession('lru-a')).toBeUndefined();
      expect(getReplSession('lru-b')).toBeDefined();
      expect(getReplSession('lru-d')).toBeDefined();
    });

    it('configureReplSessionRegistry merges partial options without resetting others', () => {
      configureReplSessionRegistry({ maxSessions: 7 });
      configureReplSessionRegistry({ idleTtlMs: 10_000 });
      // Both values stick
      getOrCreateReplSession({ sessionId: 'cfg-test', executor: 'in-process-unsafe' });
      // The values are private, but we verify behavior: maxSessions=7 means
      // we can create 7 without eviction
      for (let i = 0; i < 6; i++) getOrCreateReplSession({ sessionId: `cfg-fill-${i}`, executor: 'in-process-unsafe' });
      expect(activeReplSessionCount()).toBe(7);
    });
  });

  describe('Quest 3a M3: observability events', () => {
    it('emits code:start and code:end around runCode', async () => {
      const session = new ReplSession({ sessionId: 'evt-1', executor: 'in-process-unsafe' });
      const events: string[] = [];
      session.on('code:start', e => events.push(`start:${e.codeBytes}`));
      session.on('code:end', e => events.push(`end:${e.ok ? 'ok' : 'error'}`));

      await session.runCode('x = 1; console.log(x);');
      expect(events).toEqual(['start:22', 'end:ok']);
    });

    it('emits code:end with ok=false when the code throws', async () => {
      const session = new ReplSession({ sessionId: 'evt-2', executor: 'in-process-unsafe' });
      const ends: { ok: boolean; error: string | null }[] = [];
      session.on('code:end', e => ends.push({ ok: e.ok, error: e.error }));

      await session.runCode('throw new Error("boom");');
      expect(ends).toHaveLength(1);
      expect(ends[0].ok).toBe(false);
      expect(ends[0].error).toContain('boom');
    });

    it('emits subllm:recorded with cumulative totals', () => {
      const session = new ReplSession({ sessionId: 'evt-3', executor: 'in-process-unsafe' });
      const events: { cumCalls: number; cumCost: number }[] = [];
      session.on('subllm:recorded', e => events.push({ cumCalls: e.cumulativeCalls, cumCost: e.cumulativeCostUsd }));

      session.recordSubLlm({ costUsd: 0.001, promptTokens: 100 });
      session.recordSubLlm({ costUsd: 0.002, promptTokens: 200 });

      expect(events).toEqual([
        { cumCalls: 1, cumCost: 0.001 },
        { cumCalls: 2, cumCost: 0.003 },
      ]);
    });

    it('emits budget:exceeded with phase=preflight when runCode is rejected', async () => {
      const session = new ReplSession({
        executor: 'in-process-unsafe',
        sessionId: 'evt-4',
        budget: { maxExecutions: 1 },
      });
      const phases: string[] = [];
      session.on('budget:exceeded', e => phases.push(e.phase));

      await session.runCode('a = 1;');
      await expect(session.runCode('b = 2;')).rejects.toBeInstanceOf(BudgetExceededError);
      expect(phases).toEqual(['preflight']);
    });

    it('emits budget:exceeded with phase=mid-execution when recordSubLlm tips the cap', () => {
      const session = new ReplSession({
        executor: 'in-process-unsafe',
        sessionId: 'evt-5',
        budget: { maxSubLlmCalls: 2 },
      });
      const phases: string[] = [];
      session.on('budget:exceeded', e => phases.push(e.phase));

      session.recordSubLlm({ costUsd: 0 });
      session.recordSubLlm({ costUsd: 0 });
      // 3rd call exceeds the cap of 2 (semantic: > not >=)
      expect(() => session.recordSubLlm({ costUsd: 0 })).toThrowError(BudgetExceededError);
      expect(phases).toEqual(['mid-execution']);
    });

    it('listener errors do NOT break the agent loop (safeEmit swallows)', async () => {
      const session = new ReplSession({ sessionId: 'evt-6', executor: 'in-process-unsafe' });
      session.on('code:start', () => {
        throw new Error('listener bug');
      });
      // runCode completes despite the throwing listener
      const r = await session.runCode('console.log("still works");');
      expect(r.error).toBeNull();
      expect(r.stdout).toBe('still works');
    });
  });
});

describe('ReplSession sub-LLM budget reservations', () => {
  const session = (budget: { maxSubLlmCalls?: number; maxCostUsd?: number }, id: string) =>
    new ReplSession({ sessionId: id, executor: 'in-process-unsafe', budget });

  it('refuses the call that would exceed the cap while the others are still in flight', () => {
    const s = session({ maxSubLlmCalls: 3, maxCostUsd: 100 }, 'reserve-count');
    // Nothing settles: this is the fan-out shape, where every call is on the
    // wire at once. recordSubLlm could not refuse here, because it is only
    // reached on the way back.
    const held = [0, 1, 2].map(() => s.reserveSubLlm({ estimatedCostUsd: 0.001 }));
    expect(held).toHaveLength(3);
    expect(() => s.reserveSubLlm({ estimatedCostUsd: 0.001 })).toThrowError(BudgetExceededError);
    expect(s.getUsage().subLlmCalls).toBe(3);
  });

  it('counts in-flight estimates against the cost ceiling', () => {
    const s = session({ maxSubLlmCalls: 100, maxCostUsd: 1 }, 'reserve-cost');
    s.reserveSubLlm({ estimatedCostUsd: 0.6 });
    // 0.6 committed-in-flight + 0.5 would clear the $1 ceiling.
    expect(() => s.reserveSubLlm({ estimatedCostUsd: 0.5 })).toThrowError(BudgetExceededError);
  });

  it('release() hands the slot back so a failed dispatch is not charged', () => {
    const s = session({ maxSubLlmCalls: 1, maxCostUsd: 100 }, 'reserve-release');
    const r = s.reserveSubLlm({ estimatedCostUsd: 0.01 });
    expect(() => s.reserveSubLlm({ estimatedCostUsd: 0.01 })).toThrowError(BudgetExceededError);
    r.release();
    expect(s.getUsage().subLlmCalls).toBe(0);
    expect(() => s.reserveSubLlm({ estimatedCostUsd: 0.01 })).not.toThrow();
  });

  it('settle() books the real cost, not the estimate, and counts the call once', () => {
    const s = session({ maxSubLlmCalls: 10, maxCostUsd: 100 }, 'reserve-settle');
    const r = s.reserveSubLlm({ estimatedCostUsd: 5 });
    r.settle({ costUsd: 0.25, promptTokens: 100, completionTokens: 40 });

    const usage = s.getUsage();
    expect(usage.subLlmCalls).toBe(1);
    expect(usage.totalCostUsd).toBeCloseTo(0.25, 10);
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(40);
    // The estimate is fully released, so the freed headroom is usable again.
    expect(s.budgetReason()).toBeNull();
  });

  it('settle() still enforces the cost ceiling when the real cost tips it', () => {
    const s = session({ maxSubLlmCalls: 10, maxCostUsd: 0.01 }, 'reserve-settle-cap');
    const r = s.reserveSubLlm({ estimatedCostUsd: 0 });
    expect(() => r.settle({ costUsd: 0.5 })).toThrowError(BudgetExceededError);
    expect(s.getUsage().totalCostUsd).toBeCloseTo(0.5, 10);
  });

  it('settle() and release() are each idempotent and mutually exclusive', () => {
    const s = session({ maxSubLlmCalls: 10, maxCostUsd: 100 }, 'reserve-idempotent');
    const r = s.reserveSubLlm({ estimatedCostUsd: 0.01 });
    r.settle({ costUsd: 0.02 });
    r.settle({ costUsd: 0.02 });
    r.release();

    const usage = s.getUsage();
    expect(usage.subLlmCalls).toBe(1);
    expect(usage.totalCostUsd).toBeCloseTo(0.02, 10);
  });

  it('pre-flight budgetReason() counts a sibling still in flight', async () => {
    const s = session({ maxSubLlmCalls: 10, maxCostUsd: 1 }, 'reserve-preflight');
    // Two calls admitted together, each estimated at $0.40.
    const a = s.reserveSubLlm({ estimatedCostUsd: 0.4 });
    s.reserveSubLlm({ estimatedCostUsd: 0.4 });
    // The first comes back dearer than estimated but still under the ceiling
    // on its own, so it does not throw.
    a.settle({ costUsd: 0.9 });
    expect(s.getUsage().totalCostUsd).toBeCloseTo(0.9, 10);

    // Committed $0.90 alone would clear a pre-flight check. Counting the $0.40
    // sibling that is still out there does not, which is the point: the next
    // runCode must not be admitted onto a budget that is already spent.
    expect(s.budgetReason()).toMatch(/cost/);
    await expect(s.runCode('1 + 1')).rejects.toThrowError(BudgetExceededError);
  });
});

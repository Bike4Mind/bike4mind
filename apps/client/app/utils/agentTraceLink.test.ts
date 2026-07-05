import { describe, it, expect } from 'vitest';
import { buildAgentTraceSearch, AGENT_TRACE_ROUTE } from './agentTraceLink';

describe('agentTraceLink', () => {
  it('exposes the canonical history-route literal', () => {
    expect(AGENT_TRACE_ROUTE).toBe('/agent-executions');
  });

  it('puts the execution id in `expand`', () => {
    expect(buildAgentTraceSearch('exec-123')).toEqual({ expand: 'exec-123' });
  });

  it('includes the session when provided (replay-store namespace)', () => {
    expect(buildAgentTraceSearch('exec-123', 'sess-9')).toEqual({ expand: 'exec-123', session: 'sess-9' });
  });

  it('omits `session` entirely when not provided (no empty-string key)', () => {
    const search = buildAgentTraceSearch('exec-123', undefined);
    expect(search).not.toHaveProperty('session');
    expect(search.expand).toBe('exec-123');
  });
});

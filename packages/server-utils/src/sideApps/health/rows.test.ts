import { describe, expect, it } from 'vitest';
import { buildClientInputs, classifyHealthRow, type HealthRow } from './rows';
import { evaluateClient, HOUR_MS } from './rules';

const H = Date.UTC(2026, 10, 18, 11);
const usage = (over: Partial<Extract<HealthRow, { source: 'usage' }>> = {}): HealthRow => ({
  source: 'usage',
  clientId: 'app',
  hourStart: H,
  endpoint: '/api/chat',
  statusClass: '2xx',
  count: 1,
  ...over,
});

describe('classifyHealthRow', () => {
  it('counts a completed completion and a 2xx on an allowlisted sync endpoint as success', () => {
    expect(classifyHealthRow(usage({ completionOutcome: 'completed' }))).toEqual({ kind: 'success' });
    expect(classifyHealthRow(usage({ endpoint: '/api/tools/web-search' }))).toEqual({ kind: 'success' });
  });

  it('never counts a bare 2xx on the queued chat route', () => {
    expect(classifyHealthRow(usage())).toBeNull();
  });

  it('counts failed and interrupted completions and 5xx as our-fault failures', () => {
    expect(classifyHealthRow(usage({ completionOutcome: 'failed' }))).toMatchObject({
      kind: 'failure',
      ourFault: true,
    });
    expect(classifyHealthRow(usage({ completionOutcome: 'interrupted' }))).toMatchObject({ kind: 'failure' });
    expect(classifyHealthRow(usage({ statusClass: '5xx' }))).toMatchObject({ kind: 'failure', ourFault: true });
  });

  it('names the failure code on a failed completion and keeps the old text without one', () => {
    expect(classifyHealthRow(usage({ completionOutcome: 'failed', completionFailureCode: 'http_503' }))).toMatchObject({
      reason: 'completion_failed http_503',
    });
    expect(classifyHealthRow(usage({ completionOutcome: 'failed' }))).toMatchObject({ reason: 'completion_failed' });
    expect(classifyHealthRow(usage({ completionOutcome: 'failed', completionFailureCode: null }))).toMatchObject({
      reason: 'completion_failed',
    });
  });

  it('classifies terminal quest and agent states, a charged failed agent run included', () => {
    expect(classifyHealthRow({ source: 'quest', clientId: 'a', hourStart: H, count: 1, status: 'done' })).toEqual({
      kind: 'success',
    });
    expect(
      classifyHealthRow({ source: 'quest', clientId: 'a', hourStart: H, count: 1, status: 'done', errorCode: 'x' })
    ).toMatchObject({ kind: 'failure' });
    expect(
      classifyHealthRow({ source: 'agent', clientId: 'a', hourStart: H, count: 1, status: 'failed' })
    ).toMatchObject({
      kind: 'failure',
      reason: 'agent_failed',
    });
    expect(classifyHealthRow({ source: 'agent', clientId: 'a', hourStart: H, count: 1, status: 'running' })).toBeNull();
  });

  it('ignores policy refusals and counts app-fault and our-fault refusals by who is at fault', () => {
    const refusal = (reason: string): HealthRow => ({
      source: 'refusal',
      clientId: 'a',
      hourStart: H,
      count: 1,
      reason,
    });
    expect(classifyHealthRow(refusal('subscription_required'))).toBeNull();
    expect(classifyHealthRow(refusal('access_denied'))).toBeNull();
    expect(classifyHealthRow(refusal('invalid_grant'))).toMatchObject({ kind: 'failure', ourFault: false });
    expect(classifyHealthRow(refusal('server_error'))).toMatchObject({ kind: 'failure', ourFault: true });
  });
});

describe('buildClientInputs', () => {
  it('buckets by hour and keeps the last hour separate', () => {
    const hourly: HealthRow[] = [
      usage({ completionOutcome: 'completed', count: 4 }),
      usage({ completionOutcome: 'completed', hourStart: H - HOUR_MS, count: 2 }),
      usage({ completionOutcome: 'failed', count: 1 }),
    ];
    const last: HealthRow[] = [usage({ completionOutcome: 'failed', count: 7 })];
    const [input] = buildClientInputs(hourly, last);
    expect(input.hourly).toEqual([
      expect.objectContaining({ hourStart: H - HOUR_MS, successes: 2 }),
      expect.objectContaining({ hourStart: H, successes: 4, failures: 1, ourFaultFailures: 1 }),
    ]);
    expect(input.lastHour).toMatchObject({ failures: 7, successes: 0 });
  });

  it('keeps unverified-style noise out: a client with only policy refusals has no failures', () => {
    const rows: HealthRow[] = [
      { source: 'refusal', clientId: 'a', hourStart: H, count: 99, reason: 'subscription_required' },
    ];
    const [input] = buildClientInputs(rows, rows);
    expect(input.lastHour.failures).toBe(0);
    expect(input.hourly).toEqual([]);
    expect(evaluateClient(input, H + HOUR_MS).armed).toBe(false);
  });
});

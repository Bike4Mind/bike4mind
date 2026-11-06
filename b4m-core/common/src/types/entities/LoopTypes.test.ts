import { describe, it, expect } from 'vitest';
import { effectiveMergePolicy, loopRunModel, nextUtcMidnight, serviceLevelBreach } from './LoopTypes';

describe('effectiveMergePolicy', () => {
  it('defaults to review and serves green-ci as review when the org turned it off', () => {
    expect(effectiveMergePolicy(undefined)).toBe('review');
    expect(effectiveMergePolicy('green-ci')).toBe('green-ci');
    expect(effectiveMergePolicy('green-ci', true)).toBe('review');
    expect(effectiveMergePolicy('never', true)).toBe('never');
  });
});

describe('nextUtcMidnight', () => {
  it('is the start of the next UTC day', () => {
    expect(nextUtcMidnight(new Date('2026-11-05T23:59:00Z')).toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-11-05T00:00:00Z')).toISOString()).toBe('2026-11-06T00:00:00.000Z');
  });
});

describe('loopRunModel', () => {
  const loop = { model: 'base', escalationModel: 'strong' };

  it('escalates only the run that reaches the limit, the stage escalation model first', () => {
    expect(loopRunModel(loop, {}, 6, 6)).toEqual({ model: 'strong', escalated: true });
    expect(loopRunModel(loop, { model: 'stage' }, 5, 6)).toEqual({ model: 'stage', escalated: false });
    expect(loopRunModel(loop, { escalationModel: 'stage-strong' }, 6, 6)).toEqual({
      model: 'stage-strong',
      escalated: true,
    });
  });

  it('changes nothing with no escalation model set', () => {
    expect(loopRunModel({ model: 'base' }, { model: 'stage' }, 6, 6)).toEqual({ model: 'stage', escalated: false });
  });
});

describe('serviceLevelBreach', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
  const ticket = (fields: Partial<Parameters<typeof serviceLevelBreach>[0]>) => ({
    priority: 'p0' as const,
    status: 'open' as const,
    createdAt: hoursAgo(5),
    ...fields,
  });

  it('flags a p0 past 4h and a p1 past 24h by default, and honours a loop override', () => {
    expect(serviceLevelBreach(ticket({}), {}, now)).toMatchObject({ threshold: 4 });
    expect(serviceLevelBreach(ticket({ createdAt: hoursAgo(3) }), {}, now)).toBeNull();
    expect(
      serviceLevelBreach(ticket({ createdAt: hoursAgo(3) }), { serviceLevelHours: { p0: 2 } }, now)
    ).not.toBeNull();
    expect(serviceLevelBreach(ticket({ priority: 'p1' }), {}, now)).toBeNull();
    expect(serviceLevelBreach(ticket({ priority: 'p1', createdAt: hoursAgo(25) }), {}, now)).not.toBeNull();
  });

  it('counts from the last priority write', () => {
    expect(serviceLevelBreach(ticket({ prioritySetAt: hoursAgo(1) }), {}, now)).toBeNull();
  });

  it('skips p2/p3, closed tickets, owner blocks and epics, but not a ticket parked on its deps', () => {
    expect(serviceLevelBreach(ticket({ priority: 'p2' }), {}, now)).toBeNull();
    expect(serviceLevelBreach(ticket({ status: 'closed' }), {}, now)).toBeNull();
    expect(serviceLevelBreach(ticket({ status: 'blocked' }), {}, now)).toBeNull();
    expect(serviceLevelBreach(ticket({ epic: true }), {}, now)).toBeNull();
    expect(serviceLevelBreach(ticket({ status: 'blocked', blockedOn: 'dependencies' }), {}, now)).not.toBeNull();
  });
});

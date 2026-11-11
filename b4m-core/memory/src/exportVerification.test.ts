import { describe, expect, it } from 'vitest';
import { buildChain, foldEvents, shredEvent } from './ledger';
import { activationConfigForKind } from './activation';
import { verifyMemoryExport } from './exportVerification';

const principal = { kind: 'user' as const, id: 'u1' };
const exportedAt = '2026-07-03T00:00:00.000Z';
const events = buildChain([
  { principal, kind: 'assert', subject: 'role', fact: 'Engineer', at: '2026-07-01T00:00:00.000Z', sources: ['s1'] },
  { principal, kind: 'assert', subject: 'secret', fact: 'Secret', at: '2026-07-02T00:00:00.000Z' },
]);
const redacted = [events[0], shredEvent(events[1])];
const beliefs = foldEvents(redacted, { now: exportedAt, activation: activationConfigForKind('user') });

describe('verifyMemoryExport', () => {
  it('verifies a chain with redacted events and its folded beliefs', () => {
    expect(verifyMemoryExport({ principal, exportedAt, events: redacted, beliefs })).toEqual({ ok: true });
  });

  it('rejects a changed fact, removed interior event, changed principal or altered projection', () => {
    expect(
      verifyMemoryExport({ principal, exportedAt, events: [{ ...events[0], fact: 'Manager' }, redacted[1]], beliefs })
        .ok
    ).toBe(false);
    expect(verifyMemoryExport({ principal, exportedAt, events: [redacted[1]], beliefs }).ok).toBe(false);
    expect(
      verifyMemoryExport({ principal: { kind: 'user', id: 'u2' }, exportedAt, events: redacted, beliefs }).ok
    ).toBe(false);
    expect(verifyMemoryExport({ principal, exportedAt, events: redacted, beliefs: [] }).ok).toBe(false);
  });

  it('rejects a shredded event whose fact or salt was restored', () => {
    expect(
      verifyMemoryExport({ principal, exportedAt, events: [events[0], { ...redacted[1], salt: 'secret' }], beliefs }).ok
    ).toBe(false);
  });

  it('checks the null commitment on a live factless affirm', () => {
    const chain = buildChain([
      events[0],
      { principal, kind: 'affirm', subject: 'role', at: '2026-07-02T00:00:00.000Z' },
    ]);
    const projection = foldEvents(chain, { now: exportedAt, activation: activationConfigForKind('user') });
    expect(verifyMemoryExport({ principal, exportedAt, events: chain, beliefs: projection })).toEqual({ ok: true });
    expect(
      verifyMemoryExport({
        principal,
        exportedAt,
        events: [chain[0], { ...chain[1], commitment: 'fake' }],
        beliefs: projection,
      }).ok
    ).toBe(false);
  });
});

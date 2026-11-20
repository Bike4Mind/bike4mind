import { describe, expect, it } from 'vitest';
import { buildChain, foldEvents, shredEvent } from './ledger';
import { activationConfigForKind } from './activation';
import { MEMORY_EXPORT_FORMAT_VERSION, verifyMemoryExport } from './exportVerification';

const principal = { kind: 'user' as const, id: 'u1' };
const exportedAt = '2026-07-03T00:00:00.000Z';
const events = buildChain([
  { principal, kind: 'assert', subject: 'role', fact: 'Engineer', at: '2026-07-01T00:00:00.000Z', sources: ['s1'] },
  { principal, kind: 'assert', subject: 'secret', fact: 'Secret', at: '2026-07-02T00:00:00.000Z' },
]);
const redacted = [events[0], shredEvent(events[1])];
const activation = activationConfigForKind('user');
const formatVersion = MEMORY_EXPORT_FORMAT_VERSION;
const beliefs = foldEvents(redacted, { now: exportedAt, activation });

describe('verifyMemoryExport', () => {
  it('verifies a chain with redacted events and its folded beliefs', () => {
    expect(verifyMemoryExport({ formatVersion, activation, principal, exportedAt, events: redacted, beliefs })).toEqual(
      { ok: true }
    );
  });

  it('rejects a changed fact, removed interior event, changed principal or altered projection', () => {
    expect(
      verifyMemoryExport({
        formatVersion,
        activation,
        principal,
        exportedAt,
        events: [{ ...events[0], fact: 'Manager' }, redacted[1]],
        beliefs,
      }).ok
    ).toBe(false);
    expect(
      verifyMemoryExport({ formatVersion, activation, principal, exportedAt, events: [redacted[1]], beliefs }).ok
    ).toBe(false);
    expect(
      verifyMemoryExport({
        formatVersion,
        activation,
        principal: { kind: 'user', id: 'u2' },
        exportedAt,
        events: redacted,
        beliefs,
      }).ok
    ).toBe(false);
    expect(
      verifyMemoryExport({ formatVersion, activation, principal, exportedAt, events: redacted, beliefs: [] }).ok
    ).toBe(false);
  });

  it('verifies an export folded with a non-default activation config', () => {
    const custom = { ...activation, decay: 0.8, hotAbove: 1 };
    const projection = foldEvents(redacted, { now: exportedAt, activation: custom });
    expect(
      verifyMemoryExport({
        formatVersion,
        activation: custom,
        principal,
        exportedAt,
        events: redacted,
        beliefs: projection,
      })
    ).toEqual({ ok: true });
    expect(
      verifyMemoryExport({ formatVersion, activation, principal, exportedAt, events: redacted, beliefs: projection })
    ).toEqual({ ok: false, error: 'Chain verified, but exported beliefs do not match the ledger fold' });
  });

  it('rejects an unsupported format version and a malformed activation config', () => {
    expect(
      verifyMemoryExport({ formatVersion: 2, activation, principal, exportedAt, events: redacted, beliefs })
    ).toEqual({ ok: false, error: 'Unsupported export format version 2' });
    expect(
      verifyMemoryExport({
        formatVersion,
        activation: { ...activation, decay: Number.NaN },
        principal,
        exportedAt,
        events: redacted,
        beliefs,
      })
    ).toEqual({ ok: false, error: 'Invalid export structure' });
  });

  it('rejects a shredded event whose fact or salt was restored', () => {
    expect(
      verifyMemoryExport({
        formatVersion,
        activation,
        principal,
        exportedAt,
        events: [events[0], { ...redacted[1], salt: 'secret' }],
        beliefs,
      }).ok
    ).toBe(false);
  });

  it('checks the null commitment on a live factless affirm', () => {
    const chain = buildChain([
      events[0],
      { principal, kind: 'affirm', subject: 'role', at: '2026-07-02T00:00:00.000Z' },
    ]);
    const projection = foldEvents(chain, { now: exportedAt, activation: activationConfigForKind('user') });
    expect(
      verifyMemoryExport({ formatVersion, activation, principal, exportedAt, events: chain, beliefs: projection })
    ).toEqual({ ok: true });
    expect(
      verifyMemoryExport({
        formatVersion,
        activation,
        principal,
        exportedAt,
        events: [chain[0], { ...chain[1], commitment: 'fake' }],
        beliefs: projection,
      }).ok
    ).toBe(false);
  });
});

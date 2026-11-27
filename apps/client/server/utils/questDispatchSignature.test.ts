import { describe, expect, it } from 'vitest';
import { QUEST_DISPATCH_MAX_SKEW_MS, signQuestDispatch, verifyQuestDispatch } from './questDispatchSignature';

const SECRET = 'test-shared-secret';
const NOW = 1_800_000_000_000;
const identity = { questId: 'q1', userId: 'u1', sessionId: 's1' };
const body = JSON.stringify({ ...identity, message: 'hello' });

describe('questDispatchSignature', () => {
  it('verifies a signature it produced', () => {
    const signed = signQuestDispatch(SECRET, identity, body, NOW);
    expect(verifyQuestDispatch(SECRET, identity, body, signed, NOW)).toBe(true);
    expect(verifyQuestDispatch(SECRET, identity, Buffer.from(body), signed, NOW)).toBe(true);
  });

  it('does not sign with the raw secret as the HMAC key', () => {
    const signed = signQuestDispatch(SECRET, identity, body, NOW);
    const other = signQuestDispatch(`${SECRET}x`, identity, body, NOW);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.signature).not.toBe(other.signature);
  });

  it.each([
    ['userId', { ...identity, userId: 'u2' }],
    ['questId', { ...identity, questId: 'q2' }],
    ['sessionId', { ...identity, sessionId: 's2' }],
  ])('rejects a changed %s', (_field, changed) => {
    const signed = signQuestDispatch(SECRET, identity, body, NOW);
    expect(verifyQuestDispatch(SECRET, changed, body, signed, NOW)).toBe(false);
  });

  it('rejects a changed body', () => {
    const signed = signQuestDispatch(SECRET, identity, body, NOW);
    const changed = JSON.stringify({ ...identity, message: 'hello', adminRoleWithheld: false });
    expect(verifyQuestDispatch(SECRET, identity, changed, signed, NOW)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const signed = signQuestDispatch('another-secret', identity, body, NOW);
    expect(verifyQuestDispatch(SECRET, identity, body, signed, NOW)).toBe(false);
  });

  it('accepts small clock skew in either direction and rejects a stale or future timestamp', () => {
    const signed = signQuestDispatch(SECRET, identity, body, NOW);
    expect(verifyQuestDispatch(SECRET, identity, body, signed, NOW + QUEST_DISPATCH_MAX_SKEW_MS)).toBe(true);
    expect(verifyQuestDispatch(SECRET, identity, body, signed, NOW - QUEST_DISPATCH_MAX_SKEW_MS)).toBe(true);
    expect(verifyQuestDispatch(SECRET, identity, body, signed, NOW + QUEST_DISPATCH_MAX_SKEW_MS + 1)).toBe(false);
    expect(verifyQuestDispatch(SECRET, identity, body, signed, NOW - QUEST_DISPATCH_MAX_SKEW_MS - 1)).toBe(false);
  });

  it('rejects a timestamp moved to a fresh value without re-signing', () => {
    const signed = signQuestDispatch(SECRET, identity, body, NOW - 10 * QUEST_DISPATCH_MAX_SKEW_MS);
    expect(verifyQuestDispatch(SECRET, identity, body, { ...signed, timestamp: String(NOW) }, NOW)).toBe(false);
  });

  it.each([
    ['missing signature', { timestamp: String(NOW), signature: undefined }],
    ['missing timestamp', { timestamp: undefined, signature: 'a'.repeat(64) }],
    ['repeated header', { timestamp: [String(NOW)], signature: ['a'.repeat(64)] }],
    ['short signature', { timestamp: String(NOW), signature: 'abcd' }],
    ['non-hex signature', { timestamp: String(NOW), signature: 'z'.repeat(64) }],
    ['non-numeric timestamp', { timestamp: 'now', signature: 'a'.repeat(64) }],
  ])('rejects a %s without throwing', (_case, provided) => {
    expect(verifyQuestDispatch(SECRET, identity, body, provided, NOW)).toBe(false);
  });
});

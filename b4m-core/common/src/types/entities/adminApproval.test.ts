import { describe, expect, it } from 'vitest';
import { approvalParamsHash, canonicalApprovalJson } from './adminApproval';

const hashOf = (value: unknown) => approvalParamsHash(canonicalApprovalJson(value));

describe('canonicalApprovalJson', () => {
  it('hashes reordered keys at every depth the same', () => {
    const a = { action: { type: 'suspend', reason: 'spam' }, target: { kind: 'ids', userIds: ['a', 'b'] } };
    const b = { target: { userIds: ['a', 'b'], kind: 'ids' }, action: { reason: 'spam', type: 'suspend' } };
    expect(canonicalApprovalJson(a)).toBe(canonicalApprovalJson(b));
    expect(hashOf(a)).toBe(hashOf(b));
  });

  it('treats an undefined field as absent, matching what JSON stores', () => {
    expect(hashOf({ a: 1, b: undefined })).toBe(hashOf({ a: 1 }));
  });

  it.each([
    ['a changed value', { credits: 100 }, { credits: 101 }],
    ['a changed nested value', { target: { ids: ['a'] } }, { target: { ids: ['b'] } }],
    ['a reordered array', { ids: ['a', 'b'] }, { ids: ['b', 'a'] }],
    ['an empty object against no field', { a: 1, b: {} }, { a: 1 }],
    ['a number against its string', { credits: 100 }, { credits: '100' }],
  ])('distinguishes %s', (_label, left, right) => {
    expect(hashOf(left)).not.toBe(hashOf(right));
  });

  it('produces a sha256 hex digest', () => {
    expect(hashOf({})).toMatch(/^[a-f0-9]{64}$/);
  });
});

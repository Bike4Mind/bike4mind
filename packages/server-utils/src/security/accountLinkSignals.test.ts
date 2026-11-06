import { describe, expect, it } from 'vitest';
import { emailPatternSignals, groupLinkedAccounts, sharedLinkKinds } from './accountLinkSignals';

describe('emailPatternSignals', () => {
  it('reads a plus-addressed webmail address with a random-looking tag', () => {
    expect(emailPatternSignals('jordan+x7k2q9@outlook.com')).toEqual({
      plusAddressed: true,
      randomLookingPlusTag: true,
      generatedLocalPart: false,
      consumerMailDomain: true,
    });
  });

  it('does not call a word tag or a plain address random', () => {
    expect(emailPatternSignals('jordan+newsletter@gmail.com')).toMatchObject({
      plusAddressed: true,
      randomLookingPlusTag: false,
    });
    expect(emailPatternSignals('jordan@acme-labs.io')).toEqual({
      plusAddressed: false,
      randomLookingPlusTag: false,
      generatedLocalPart: false,
      consumerMailDomain: false,
    });
  });

  it('flags a hex-counter local part, ignoring the tag', () => {
    expect(emailPatternSignals('user28af6a+1@gmail.com')?.generatedLocalPart).toBe(true);
  });

  it('returns null for no address or an unusable one', () => {
    expect(emailPatternSignals(null)).toBeNull();
    expect(emailPatternSignals('not-an-email')).toBeNull();
  });
});

describe('sharedLinkKinds', () => {
  const base = { email: null, signupIp: null, signupJa4: null };

  it('links plus-tag and Gmail-dot aliases of one mailbox', () => {
    expect(sharedLinkKinds({ ...base, email: 'j.doe+a1@gmail.com' }, { ...base, email: 'jdoe@gmail.com' })).toEqual([
      'mailbox',
    ]);
  });

  it('links a shared company domain but never a shared webmail domain', () => {
    expect(sharedLinkKinds({ ...base, email: 'a@acme-labs.io' }, { ...base, email: 'b@acme-labs.io' })).toEqual([
      'mailDomain',
    ]);
    expect(sharedLinkKinds({ ...base, email: 'a@gmail.com' }, { ...base, email: 'b@gmail.com' })).toEqual([]);
    expect(sharedLinkKinds({ ...base, email: 'a@hotmail.co.uk' }, { ...base, email: 'b@hotmail.co.uk' })).toEqual([]);
  });

  it('links a shared signup IP or JA4, and never on two unknowns', () => {
    expect(
      sharedLinkKinds(
        { ...base, signupIp: '198.51.100.4', signupJa4: 'ja4_a' },
        { ...base, signupIp: '198.51.100.4', signupJa4: 'ja4_a' }
      )
    ).toEqual(['signupIp', 'ja4']);
    expect(sharedLinkKinds(base, base)).toEqual([]);
  });
});

describe('groupLinkedAccounts', () => {
  it('joins accounts transitively and leaves unrelated ones alone', () => {
    const groups = groupLinkedAccounts([
      { id: 'a', email: 'x+1@outlook.com', signupIp: '198.51.100.4', signupJa4: null },
      { id: 'b', email: 'solo@gmail.com', signupIp: '192.0.2.9', signupJa4: null },
      { id: 'c', email: 'x+2@outlook.com', signupIp: null, signupJa4: 'ja4_z' },
      { id: 'd', email: 'other@gmail.com', signupIp: null, signupJa4: 'ja4_z' },
    ]);
    expect(groups).toEqual([
      { memberIds: ['a', 'c', 'd'], kinds: ['ja4', 'mailbox'] },
      { memberIds: ['b'], kinds: [] },
    ]);
  });
});

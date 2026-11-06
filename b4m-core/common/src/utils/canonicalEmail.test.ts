import { describe, expect, it } from 'vitest';
import { canonicalizeEmail, isRandomLookingTag, plusAddressTagOf } from './canonicalEmail';

describe('canonicalizeEmail', () => {
  it.each([
    ['x+1@gmail.com', 'x@gmail.com'],
    ['x+2@gmail.com', 'x@gmail.com'],
    ['x.y@gmail.com', 'xy@gmail.com'],
    ['X.Y+promo.code@Gmail.COM', 'xy@gmail.com'],
    ['x.y@googlemail.com', 'xy@gmail.com'],
    ['  x@gmail.com  ', 'x@gmail.com'],
    ['x@gmail.com.', 'x@gmail.com'],
  ])('folds the Gmail alias %s to %s', (input, expected) => {
    expect(canonicalizeEmail(input)).toBe(expected);
  });

  it.each([
    ['me+news@outlook.com', 'me@outlook.com'],
    ['Me+news@iCloud.com', 'me@icloud.com'],
    ['me+a+b@proton.me', 'me@proton.me'],
    ['me+news@hotmail.co.uk', 'me@hotmail.co.uk'],
  ])('strips the plus tag for the plus-addressing provider in %s', (input, expected) => {
    expect(canonicalizeEmail(input)).toBe(expected);
  });

  it.each([
    ['me@me.com', 'me@icloud.com'],
    ['me+tag@mac.com', 'me@icloud.com'],
    ['me@protonmail.com', 'me@proton.me'],
    ['me+tag@pm.me', 'me@proton.me'],
  ])('folds the same-mailbox domain in %s', (input, expected) => {
    expect(canonicalizeEmail(input)).toBe(expected);
  });

  it.each([
    ['First.Last+tag@Example.com', 'first.last+tag@example.com'],
    ['a.b@outlook.com', 'a.b@outlook.com'],
    ['me@constructor', 'me@constructor'],
  ])('only lowercases where the provider does not alias %s', (input, expected) => {
    expect(canonicalizeEmail(input)).toBe(expected);
  });

  it('keeps distinct Gmail inboxes distinct', () => {
    expect(canonicalizeEmail('xy@gmail.com')).not.toBe(canonicalizeEmail('xz@gmail.com'));
  });

  it.each(['', 'no-at-sign', '@gmail.com', 'x@', '+tag@gmail.com', '...@gmail.com', '+tag@outlook.com'])(
    'returns null for the unusable address %j',
    input => {
      expect(canonicalizeEmail(input)).toBeNull();
    }
  );
});

describe('plusAddressTagOf', () => {
  it.each([
    ['someone+Shop@Hotmail.com', 'shop'],
    ['someone+gk283e0g6w@outlook.com', 'gk283e0g6w'],
    ['some.one+news@googlemail.com', 'news'],
    ['someone+x@me.com', 'x'],
  ])('reads the tag of %s', (email, tag) => {
    expect(plusAddressTagOf(email)).toBe(tag);
  });

  it.each([
    'someone@hotmail.com',
    'someone+@outlook.com',
    '+tag@outlook.com',
    'someone+tag@example.test',
    'not-an-email',
  ])('is null for %s', email => {
    expect(plusAddressTagOf(email)).toBeNull();
  });
});

describe('isRandomLookingTag', () => {
  it.each(['gk283e0g6w', 'usafnzdxsh', 'lxuby5k7np', 'f5o8smiltw'])('flags a generated tag (%s)', tag => {
    expect(isRandomLookingTag(tag)).toBe(true);
  });

  it.each(['shopping', 'newsletters', 'work2024', 'amazon', 'netflix', 'github', 'receipts', 'job-hunt', 'a1b2c3'])(
    'leaves a human tag alone (%s)',
    tag => {
      expect(isRandomLookingTag(tag)).toBe(false);
    }
  );
});

import { describe, it, expect } from 'vitest';
import { isWellFormedShareToken, parsePublishPath } from './parsePublishPath';
import { generateShareToken } from './shareToken';

describe('parsePublishPath share links', () => {
  it('resolves a minted token and its asset path', () => {
    const token = generateShareToken();
    expect(parsePublishPath(['a', token, 'img', 'x.png'])).toEqual({
      kind: 'share',
      shareToken: token,
      assetPath: 'img/x.png',
    });
  });

  it.each([':path*', 'a b', 'tok%00', 'x'.repeat(65), ''])('rejects the malformed token %j', token => {
    expect(isWellFormedShareToken(token)).toBe(false);
    expect(parsePublishPath(['a', token])).toBeNull();
  });

  it('accepts every token the generator mints', () => {
    for (let i = 0; i < 100; i++) expect(isWellFormedShareToken(generateShareToken())).toBe(true);
  });
});

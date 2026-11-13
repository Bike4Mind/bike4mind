import { describe, expect, it } from 'vitest';
import { parseSkillsScope } from './scope';

describe('parseSkillsScope', () => {
  it('keeps a session id and an absolute draft folder', () => {
    expect(parseSkillsScope({ sessionId: 's1' })).toEqual({ sessionId: 's1' });
    expect(parseSkillsScope({ draftDirectory: '/repo/./app' })).toEqual({ draftDirectory: '/repo/app' });
    expect(parseSkillsScope({ draftDirectory: null })).toEqual({ draftDirectory: null });
  });

  it('refuses anything else', () => {
    for (const raw of [
      null,
      'raw-id',
      42,
      {},
      { sessionId: 7 },
      { draftDirectory: 'relative/dir' },
      { draftDirectory: 3 },
    ])
      expect(parseSkillsScope(raw)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { transitPhase } from './transitPhase';

describe('transitPhase', () => {
  it.each([
    ['done', 'done'],
    ['failed', 'off-line'],
    ['stopped', 'off-line'],
    ['needs-you', 'waiting'],
    ['idle', 'waiting'],
  ] as const)('puts a %s agent at %s whatever its text says', (state, expected) => {
    expect(transitPhase(state)).toBe(expected);
    expect(transitPhase(state, 'file_edit a.ts')).toBe(expected);
  });

  it.each([
    ['Thinking', 'planning'],
    ['Planning the change', 'planning'],
    ['file_edit app.ts', 'working'],
    ['file_write app.ts', 'working'],
    ['file_read README.md', 'working'],
    ['bash_execute pnpm build', 'working'],
    ['grep_search useState', 'working'],
    ['Writing a reply', 'working'],
    ['Preparing file_edit', 'working'],
    ['bash_execute pnpm test', 'reviewing'],
    ['bash_execute pnpm typecheck', 'reviewing'],
    ['file_edit check.ts', 'working'],
    ['file_read lint.config.ts', 'working'],
    ['file_write test.ts', 'working'],
  ] as const)('reads a working agent doing "%s" as %s', (text, expected) => {
    expect(transitPhase('working', text)).toBe(expected);
  });

  it.each([undefined, '', '   ', 'Waiting on the model', 'Starting up', 'Frobnicating'])(
    'sends a working agent with unknown activity %j to Waiting',
    text => {
      expect(transitPhase('working', text)).toBe('waiting');
    }
  );
});

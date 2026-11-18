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
    expect(transitPhase(state, 'Edit src/a.ts')).toBe(expected);
  });

  it.each([
    ['Thinking', 'planning'],
    ['Planning the change', 'planning'],
    ['Edit src/app.ts', 'working'],
    ['Bash pnpm build', 'working'],
    ['Read README.md', 'working'],
    ['Writing a reply', 'working'],
    ['Preparing Edit', 'working'],
    ['Bash pnpm test', 'reviewing'],
    ['Bash pnpm typecheck', 'reviewing'],
    ['Reviewing the diff', 'reviewing'],
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

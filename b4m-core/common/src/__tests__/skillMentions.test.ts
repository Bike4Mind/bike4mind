import { describe, it, expect } from 'vitest';
import { detectSkillMentions } from '../utils/skillMentions';
import { substituteArguments, parseSkillArguments } from '../utils/skillArguments';

describe('detectSkillMentions', () => {
  it('finds a single mention with empty args', () => {
    expect(detectSkillMentions('/summarize')).toEqual([{ name: 'summarize', args: '' }]);
  });

  it('captures args following the mention', () => {
    expect(detectSkillMentions('/summarize hello world')).toEqual([{ name: 'summarize', args: 'hello world' }]);
  });

  it('captures kebab-case names', () => {
    expect(detectSkillMentions('/review-pr 123')).toEqual([{ name: 'review-pr', args: '123' }]);
  });

  it('captures multiple mentions and splits their args', () => {
    expect(detectSkillMentions('/summarize hi /translate english')).toEqual([
      { name: 'summarize', args: 'hi' },
      { name: 'translate', args: 'english' },
    ]);
  });

  it('ignores slashes in URLs', () => {
    // Slash is preceded by a colon, not whitespace, so URLs do not match.
    expect(detectSkillMentions('see https://example.com/foo for context')).toEqual([]);
  });

  it('ignores nested paths like /etc/passwd', () => {
    // `/etc` is followed by `/`, which is NOT a valid terminator.
    expect(detectSkillMentions('cat /etc/passwd')).toEqual([]);
  });

  it('strips leading terminator punctuation from args', () => {
    // The regex allows `?`, `.`, `,`, etc. as terminators so the mention
    // matches in prose, but those characters aren't part of the args.
    expect(detectSkillMentions('can you run /summarize? thanks')).toEqual([{ name: 'summarize', args: 'thanks' }]);
    expect(detectSkillMentions('/summarize, then translate')).toEqual([{ name: 'summarize', args: 'then translate' }]);
    expect(detectSkillMentions('/summarize.')).toEqual([{ name: 'summarize', args: '' }]);
  });

  it('returns an empty array when no mentions exist', () => {
    expect(detectSkillMentions('hello there, no slash commands here')).toEqual([]);
  });

  it('rejects uppercase names (matches kebab-case only)', () => {
    expect(detectSkillMentions('/Summarize text')).toEqual([]);
  });
});

describe('substituteArguments', () => {
  it('replaces $ARGUMENTS with joined args', () => {
    expect(substituteArguments('echo $ARGUMENTS', ['hello', 'world'])).toBe('echo hello world');
  });

  it('replaces positional args $1, $2, ...', () => {
    expect(substituteArguments('first=$1 second=$2', ['a', 'b'])).toBe('first=a second=b');
  });

  it('does not let $1 consume part of $10', () => {
    const args = Array.from({ length: 10 }, (_, i) => String(i + 1));
    expect(substituteArguments('$10 and $1', args)).toBe('10 and 1');
  });

  it('leaves unused positional args unreplaced (mirrors CLI behavior)', () => {
    // We only iterate up to args.length, so `$2` stays visible when only one
    // arg is supplied - surfacing the mismatch instead of silently dropping it.
    expect(substituteArguments('$1 and $2', ['only-one'])).toBe('only-one and $2');
  });

  it('leaves text without patterns unchanged', () => {
    expect(substituteArguments('no patterns here', ['ignored'])).toBe('no patterns here');
  });
});

describe('parseSkillArguments', () => {
  it('splits on whitespace', () => {
    expect(parseSkillArguments('hello world')).toEqual(['hello', 'world']);
  });

  it('preserves double-quoted phrases', () => {
    expect(parseSkillArguments('"hello world" test')).toEqual(['hello world', 'test']);
  });

  it('preserves single-quoted phrases', () => {
    expect(parseSkillArguments("'one two' three")).toEqual(['one two', 'three']);
  });

  it('returns an empty array for empty input', () => {
    expect(parseSkillArguments('')).toEqual([]);
  });

  it('handles multiple whitespace characters', () => {
    expect(parseSkillArguments('a  \tb\nc')).toEqual(['a', 'b', 'c']);
  });
});

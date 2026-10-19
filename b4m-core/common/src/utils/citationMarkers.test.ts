import { describe, it, expect } from 'vitest';
import { findCitationMarkers, sourceNamedIn } from './citationMarkers';

const valuesOf = (text: string) => findCitationMarkers(text).map(match => match.numbers.map(n => n.value));

describe('findCitationMarkers', () => {
  it('finds single and comma-listed markers with their offsets', () => {
    expect(findCitationMarkers('Holidays [1] and both [2, 13].')).toEqual([
      { text: '[1]', start: 9, numbers: [{ value: 1, digits: '1', offset: 1 }] },
      {
        text: '[2, 13]',
        start: 22,
        numbers: [
          { value: 2, digits: '2', offset: 1 },
          { value: 13, digits: '13', offset: 4 },
        ],
      },
    ]);
  });

  it('never reads a three-digit bracket as a citation', () => {
    expect(valuesOf('In [2016] we saw [146] cases [1,100].')).toEqual([]);
  });

  it('ignores ranges and non-numeric brackets', () => {
    expect(valuesOf('See [1-3], [a], [ 1 ] and []')).toEqual([]);
  });

  it('reads adjacent markers separately', () => {
    expect(valuesOf('[1][2]')).toEqual([[1], [2]]);
  });

  it('reads a comma list on one line but not one that spans a line break', () => {
    expect(valuesOf('[1, 2]')).toEqual([[1, 2]]);
    expect(valuesOf('[1,\n2]')).toEqual([]);
  });
});

describe('sourceNamedIn', () => {
  it('matches a file name with or without its extension, or as spaced words', () => {
    expect(sourceNamedIn('See galilean-moons.md for more.', 'galilean-moons.md')).toBe(true);
    expect(sourceNamedIn('Per galilean-moons, Io is volcanic.', 'galilean-moons.md')).toBe(true);
    expect(sourceNamedIn('The Galilean Moons note says so.', 'galilean-moons.md')).toBe(true);
  });

  it('does not match a name the text never mentions, or only part of one', () => {
    expect(sourceNamedIn('Io is volcanic.', 'galilean-moons.md')).toBe(false);
    expect(sourceNamedIn('A samples table.', 'sample.yaml')).toBe(false);
  });

  it('treats regex characters in a name literally', () => {
    expect(sourceNamedIn('Read notes (v2) first.', 'notes (v2).md')).toBe(true);
    expect(sourceNamedIn('Read notes v2 first.', 'notes (v2).md')).toBe(false);
  });

  it('matches nothing for a name that is not a string, as a malformed stored citable may carry', () => {
    expect(sourceNamedIn('anything at all', undefined as unknown as string)).toBe(false);
  });

  it('matches nothing for a name with no words', () => {
    expect(sourceNamedIn('anything at all', '')).toBe(false);
    expect(sourceNamedIn('anything at all', ' - ')).toBe(false);
  });
});

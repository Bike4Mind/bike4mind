import { describe, it, expect } from 'vitest';
import { findCitationMarkers } from './citationMarkers';

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

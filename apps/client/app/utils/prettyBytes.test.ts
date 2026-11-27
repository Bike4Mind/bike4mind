import { describe, expect, it } from 'vitest';
import { prettyBytes } from './prettyBytes';

// Expected strings were captured from pretty-bytes 7.1.3 called with default options.
const CASES: Array<[number, string]> = [
  [0, '0 B'],
  [1, '1 B'],
  [9, '9 B'],
  [10, '10 B'],
  [42, '42 B'],
  [99, '99 B'],
  [100, '100 B'],
  [512, '512 B'],
  [999, '999 B'],
  [999.4, '999 B'],
  [999.5, '1 kB'],
  [1000, '1 kB'],
  [1001, '1 kB'],
  [1023, '1.02 kB'],
  [1024, '1.02 kB'],
  [1500, '1.5 kB'],
  [1536, '1.54 kB'],
  [9994, '9.99 kB'],
  [9995, '9.99 kB'],
  [9999, '10 kB'],
  [10000, '10 kB'],
  [12345, '12.3 kB'],
  [99949, '99.9 kB'],
  [99950, '100 kB'],
  [99999, '100 kB'],
  [100000, '100 kB'],
  [123456, '123 kB'],
  [999499, '999 kB'],
  [999500, '1 MB'],
  [999949, '1 MB'],
  [999950, '1 MB'],
  [999999, '1 MB'],
  [1000000, '1 MB'],
  [1500000, '1.5 MB'],
  [12345678, '12.3 MB'],
  [104857600, '105 MB'],
  [999949999, '1 GB'],
  [999950000, '1 GB'],
  [1073741824, '1.07 GB'],
  [5368709120, '5.37 GB'],
  [5e9, '5 GB'],
  [2.5e12, '2.5 TB'],
  [999950e9, '1 PB'],
  [1e15, '1 PB'],
  [1e18, '1 EB'],
  [1e21, '1 ZB'],
  [1e24, '1 YB'],
  [999.5e24, '1000 YB'],
  [1e27, '1000 YB'],
  [1e30, '1000000 YB'],
  [0.5, '0.5 B'],
  [0.001, '0.001 B'],
  [1.234, '1.23 B'],
  [0.1 + 0.2, '0.3 B'],
  [2 ** 53 - 1, '9.01 PB'],
  [-1, '-1 B'],
  [-1500, '-1.5 kB'],
  [-0.5, '-0.5 B'],
  [-999999, '-1 MB'],
  [-1e9, '-1 GB'],
  [-0, '0 B'],
];

describe('prettyBytes', () => {
  it.each(CASES)('formats %s as %s', (bytes, expected) => {
    expect(prettyBytes(bytes)).toBe(expected);
  });

  it.each([NaN, Infinity, -Infinity])('throws a TypeError for %s', value => {
    expect(() => prettyBytes(value)).toThrow(TypeError);
    expect(() => prettyBytes(value)).toThrow(`Expected a finite number, got number: ${value}`);
  });

  it('throws a TypeError for a missing value', () => {
    expect(() => prettyBytes(undefined as unknown as number)).toThrow(
      'Expected a finite number, got undefined: undefined'
    );
  });
});

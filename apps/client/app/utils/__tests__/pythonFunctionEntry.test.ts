import { describe, expect, it } from 'vitest';
import { hasFunctionEntryPoint } from '../pythonFunctionEntry';

describe('hasFunctionEntryPoint', () => {
  it('is true with a FUNCTION assignment and a run definition at column 0', () => {
    expect(hasFunctionEntryPoint('FUNCTION = {}\n\ndef run(span):\n    return {}')).toBe(true);
    expect(hasFunctionEntryPoint('FUNCTION={}\nasync def run():\n    return {}')).toBe(true);
  });

  it('is false with only one of the two markers', () => {
    expect(hasFunctionEntryPoint('FUNCTION = {}\nprint(1)')).toBe(false);
    expect(hasFunctionEntryPoint('def run(span):\n    return {}')).toBe(false);
    expect(hasFunctionEntryPoint('import numpy as np\nprint(np.pi)')).toBe(false);
  });

  it('is false when run is defined inside another block', () => {
    expect(hasFunctionEntryPoint('FUNCTION = {}\nclass Beam:\n    def run(self):\n        return {}')).toBe(false);
  });

  it('does not match a similar name', () => {
    expect(hasFunctionEntryPoint('FUNCTIONS = {}\ndef run():\n    return {}')).toBe(false);
    expect(hasFunctionEntryPoint('FUNCTION = {}\ndef runner():\n    return {}')).toBe(false);
  });

  it('accepts FUNCTION at column 0 inside a string, since the sandbox decides', () => {
    const code = 'NOTE = """\nFUNCTION = {}\n"""\ndef run():\n    return {}';
    expect(hasFunctionEntryPoint(code)).toBe(true);
  });
});

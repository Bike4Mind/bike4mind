import { describe, it, expect } from 'vitest';
import {
  FUNCTION_CALL_GLUE_PY,
  FUNCTION_RESULT_TOO_LARGE_MESSAGE,
  FUNCTION_RESULT_TOO_LARGE_PREFIX,
  functionCallGluePy,
  functionResultTooLargeMessage,
} from './functionCallGlue';

describe('functionCallGluePy', () => {
  it('keeps the browser glue at 5 MB, the server runtime ceiling', () => {
    expect(FUNCTION_CALL_GLUE_PY).toBe(functionCallGluePy(5 * 1024 * 1024));
    expect(FUNCTION_CALL_GLUE_PY).toContain('_MAX_RESULT_BYTES = 5242880\n');
    expect(FUNCTION_CALL_GLUE_PY).toContain(`raise _FunctionCallError('${FUNCTION_RESULT_TOO_LARGE_MESSAGE}')`);
    expect(FUNCTION_RESULT_TOO_LARGE_MESSAGE).toBe('The function returned a result larger than 5 MB.');
  });

  it('writes another cap into the glue and its refusal', () => {
    const glue = functionCallGluePy(5 * 1024 * 1024);
    expect(glue).toContain('_MAX_RESULT_BYTES = 5242880\n');
    expect(glue).toContain(`raise _FunctionCallError('${FUNCTION_RESULT_TOO_LARGE_PREFIX} 5 MB.')`);
    expect(functionResultTooLargeMessage(1000)).toBe(`${FUNCTION_RESULT_TOO_LARGE_PREFIX} 1000 bytes.`);
  });

  it('refuses a cap that is not a positive whole number', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => functionCallGluePy(bad)).toThrow(RangeError);
    }
  });
});

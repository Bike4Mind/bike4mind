import { describe, expect, it } from 'vitest';
import { hasFunctionEntryPoint as fromCommon } from '@bike4mind/common';
import { hasFunctionEntryPoint } from '../pythonFunctionEntry';

// The cases live with the function in b4m-core/common/src/schemas/functionContract.test.ts.
describe('hasFunctionEntryPoint', () => {
  it('is the common check, so the Function tab and the server agree', () => {
    expect(hasFunctionEntryPoint).toBe(fromCommon);
  });
});

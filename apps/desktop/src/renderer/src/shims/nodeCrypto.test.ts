import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from './nodeCrypto';

// What matters about the shim is that it fails loudly: a stub that returned an empty
// digest would put a wrong hash into whatever called it.
describe('renderer node:crypto shim', () => {
  it('throws from createHash', () => {
    expect(() => createHash('sha256')).toThrow(/main process/);
  });

  it('throws from createHmac', () => {
    expect(() => createHmac('sha256', 'key')).toThrow(/main process/);
  });
});

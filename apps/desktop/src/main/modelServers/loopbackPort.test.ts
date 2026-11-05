import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackPortFree } from './loopbackPort';

let held: Server | null = null;

afterEach(async () => {
  const server = held;
  held = null;
  if (server) await new Promise(resolve => server.close(resolve));
});

describe('loopbackPortFree', () => {
  it('is false while something listens on the port, even if it never answers, and true once it stops', async () => {
    const server = createServer(() => undefined);
    held = server;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    expect(await loopbackPortFree(address.port)).toBe(false);
    held = null;
    await new Promise(resolve => server.close(resolve));
    expect(await loopbackPortFree(address.port)).toBe(true);
  });
});

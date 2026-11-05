import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackLaunchPort, loopbackPortFree } from './loopbackPort';

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

  it('on Windows also needs the wildcard address, and releases both binds', async () => {
    // Linux refuses a 0.0.0.0 bind while 127.0.0.2 holds the port, but allows 127.0.0.1: the gap Windows has.
    const server = createServer(() => undefined);
    held = server;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.2', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    expect(await loopbackPortFree(address.port, 'linux')).toBe(true);
    expect(await loopbackPortFree(address.port, 'win32')).toBe(false);
    held = null;
    await new Promise(resolve => server.close(resolve));
    expect(await loopbackPortFree(address.port, 'win32')).toBe(true);
    expect(await loopbackPortFree(address.port, 'win32')).toBe(true);
  });
});

describe('loopbackLaunchPort', () => {
  it('takes plain http on 127.0.0.1 or localhost with a port, at the root or /v1', () => {
    expect(loopbackLaunchPort('http://127.0.0.1:11500')).toBe(11500);
    expect(loopbackLaunchPort('http://localhost:8090/v1')).toBe(8090);
    expect(loopbackLaunchPort('http://10.0.0.5:11434')).toBeNull();
    expect(loopbackLaunchPort('https://127.0.0.1:11500')).toBeNull();
    expect(loopbackLaunchPort('http://127.0.0.1:8090/api')).toBeNull();
    expect(loopbackLaunchPort('not a url')).toBeNull();
  });
});

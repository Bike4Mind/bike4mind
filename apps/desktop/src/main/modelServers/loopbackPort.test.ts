import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackLaunchPort, loopbackPortFree, loopbackPortListening } from './loopbackPort';

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

  it('on Windows also counts a listener a connect reaches, without binding the wildcard address', async () => {
    const server = createServer(() => undefined);
    held = server;
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    expect(await loopbackPortFree(address.port, 'win32')).toBe(false);
    held = null;
    await new Promise(resolve => server.close(resolve));
    expect(await loopbackPortFree(address.port, 'win32')).toBe(true);
    expect(await loopbackPortFree(address.port, 'win32')).toBe(true);
  });
});

describe('loopbackPortListening', () => {
  it('is true while something listens on 127.0.0.1 or the wildcard address, false once it stops', async () => {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const server = createServer(() => undefined);
      held = server;
      await new Promise<void>(resolve => server.listen(0, host, resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');

      expect(await loopbackPortListening(address.port)).toBe(true);
      held = null;
      await new Promise(resolve => server.close(resolve));
      expect(await loopbackPortListening(address.port)).toBe(false);
    }
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

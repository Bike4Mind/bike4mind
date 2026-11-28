import { describe, expect, it, vi } from 'vitest';
import { createHostCommands } from './hostCommands';

function setup(overrides: Partial<Parameters<typeof createHostCommands>[0] extends () => infer R ? R : never> = {}) {
  const calls: string[] = [];
  const source = {
    connect: vi.fn(async (hostId: string) => void calls.push(`connect ${hostId}`)),
    disconnect: vi.fn(async (hostId: string) => void calls.push(`disconnect ${hostId}`)),
    remove: vi.fn(async (hostId: string) => void calls.push(`remove ${hostId}`)),
    signInApp: vi.fn(async () => void calls.push('signInApp')),
    ...overrides,
  };
  return { commands: createHostCommands(() => source), calls, source };
}

describe('host commands', () => {
  it('reconnects a connected host by disconnecting first, and any other state by connecting', async () => {
    const { commands, calls } = setup();
    await commands.reconnect('h', true);
    await commands.reconnect('h', false);
    expect(calls).toEqual(['disconnect h', 'connect h', 'connect h']);
  });

  it('keeps a failure per host for whoever shows it, and clears it on the next command on that host', async () => {
    const { commands } = setup({
      connect: async hostId => {
        if (hostId === 'bad') throw new Error('ssh: no route');
      },
    });
    const heard = vi.fn();
    commands.subscribe(heard);
    await commands.connect('bad');
    expect(commands.error('bad')).toBe('ssh: no route');
    expect(commands.error('good')).toBeNull();
    expect(heard).toHaveBeenCalled();
    await commands.disconnect('bad');
    expect(commands.error('bad')).toBeNull();
  });

  it('never rejects: a failing sign-in is a recorded error too', async () => {
    const { commands } = setup({
      signInApp: async () => {
        throw new Error('browser did not open');
      },
    });
    await expect(commands.signInApp('h')).resolves.toBeUndefined();
    expect(commands.error('h')).toBe('browser did not open');
  });
});

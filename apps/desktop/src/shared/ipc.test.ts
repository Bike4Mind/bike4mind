import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from './ipc';

describe('IPC_CHANNELS', () => {
  it('maps every name to a distinct channel', () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('namespaces every channel', () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel).toMatch(/^[a-z]+:[a-z-]+$/);
    }
  });
});

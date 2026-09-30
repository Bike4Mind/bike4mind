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

  // The renderer may only learn derived auth state. A channel named for a credential is the
  // shape this boundary fails in, so name the rule here rather than trusting review.
  it('exposes no channel that reads a credential', () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel).not.toMatch(/token|secret|credential|device-code/);
    }
  });

  // An approval is answered in the conversation that raised it and nowhere else. A channel
  // carrying the whole pending set to any open window is what let one conversation's prompt
  // interrupt another, so name the rule here rather than trusting review.
  it('exposes no channel that feeds one conversation approvals from another', () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel).not.toMatch(/pending-approval/);
    }
  });
});

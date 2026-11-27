import { describe, expect, it } from 'vitest';
import type { HostEntry } from '@shared/hostConnection';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { fakeHostInfo } from '../__fixtures__/chatBackedHostBridge';
import { sessionCapabilities } from './sessionCapabilities';

const remote = (capabilities: string[], connected = true): HostEntry => ({
  hostId: 'devbox',
  label: 'Devbox',
  kind: 'remote',
  state: connected
    ? { status: 'connected', info: fakeHostInfo('devbox', capabilities), latencyMs: 1 }
    : { status: 'offline', reason: 'unreachable', lastSeenAt: null },
});

describe('sessionCapabilities', () => {
  it('offers everything for a local session, stamped or not', () => {
    const all = { desktopChat: true, terminal: true, browser: true, models: true, loops: true, queue: true };
    expect(sessionCapabilities({}, [])).toEqual(all);
    expect(sessionCapabilities({ hostId: LOCAL_HOST_ID }, [])).toEqual(all);
    expect(sessionCapabilities(null, [])).toEqual(all);
  });

  it('turns off every control without a protocol path for a remote session', () => {
    const capabilities = sessionCapabilities({ hostId: 'devbox' }, [
      remote(['terminals', 'browserTools', 'localModels', 'loops']),
    ]);
    expect(capabilities).toEqual({
      desktopChat: false,
      terminal: false,
      browser: false,
      models: false,
      loops: false,
      queue: false,
    });
  });

  it('offers the queue only when the remote host advertises it and is connected', () => {
    expect(sessionCapabilities({ hostId: 'devbox' }, [remote(['queue'])]).queue).toBe(true);
    expect(sessionCapabilities({ hostId: 'devbox' }, [remote(['queue'], false)]).queue).toBe(false);
    expect(sessionCapabilities({ hostId: 'unknown' }, []).queue).toBe(false);
  });
});

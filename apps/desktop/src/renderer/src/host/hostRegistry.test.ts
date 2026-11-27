import { describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import type { HostEntry } from '@shared/hostConnection';
import { fakeHostInfo } from '../__fixtures__/chatBackedHostBridge';
import { createHostRegistry, hostCapabilities, servingHostIds } from './hostRegistry';

const local: HostEntry = {
  hostId: LOCAL_HOST_ID,
  label: 'This Mac',
  kind: 'local',
  state: { status: 'connected', info: fakeHostInfo(LOCAL_HOST_ID), latencyMs: 0 },
};
const devbox = (connected: boolean): HostEntry => ({
  hostId: 'devbox',
  label: 'Devbox',
  kind: 'remote',
  state: connected
    ? { status: 'connected', info: fakeHostInfo('devbox', ['queue']), latencyMs: 3 }
    : { status: 'reconnecting', attempt: 1, nextRetryAt: 0 },
});

describe('host helpers', () => {
  it('always serves the local host, and a remote one only while connected', () => {
    expect(servingHostIds([])).toEqual([LOCAL_HOST_ID]);
    expect(servingHostIds([local, devbox(true)])).toEqual([LOCAL_HOST_ID, 'devbox']);
    expect(servingHostIds([local, devbox(false)])).toEqual([LOCAL_HOST_ID]);
  });

  it('reads capabilities from a connected host only', () => {
    expect(hostCapabilities('devbox', [devbox(true)])).toEqual(['queue']);
    expect(hostCapabilities('devbox', [devbox(false)])).toEqual([]);
  });
});

describe('createHostRegistry', () => {
  it('listens only while subscribed and prefers a push over a slower first list', async () => {
    let push: (hosts: HostEntry[]) => void = () => undefined;
    let answerList: (hosts: HostEntry[]) => void = () => undefined;
    const off = vi.fn();
    const source = {
      list: vi.fn(() => new Promise<HostEntry[]>(resolve => (answerList = resolve))),
      onStateChanged: vi.fn((listener: (hosts: HostEntry[]) => void) => {
        push = listener;
        return off;
      }),
    };
    const registry = createHostRegistry(() => source);
    expect(source.list).not.toHaveBeenCalled();

    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    push([local, devbox(true)]);
    answerList([local]);
    await Promise.resolve();
    expect(registry.entries().map(entry => entry.hostId)).toEqual([LOCAL_HOST_ID, 'devbox']);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(off).toHaveBeenCalled();
    expect(registry.entries()).toEqual([]);
  });

  it('reports a list that fails', async () => {
    const reportError = vi.fn();
    const registry = createHostRegistry(
      () => ({ list: () => Promise.reject(new Error('down')), onStateChanged: () => () => undefined }),
      reportError
    );
    registry.subscribe(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(reportError).toHaveBeenCalledWith('Could not list the hosts', expect.any(Error));
  });
});

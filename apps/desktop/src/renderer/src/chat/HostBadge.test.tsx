// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostConnectionState } from '@shared/hostConnection';
import { chatBackedHostBridge, fakeHostInfo, type FakeRemoteHostOptions } from '../__fixtures__/chatBackedHostBridge';
import {
  byTestId,
  allByTestId,
  click,
  DESKTOP_VERSION,
  mountHostUi,
  settle,
  textOf,
  type MountedHostUi,
} from '../__fixtures__/mountHostUi';
import { HostBadge, HostComposerChip, HostListPlaceholder, HostProjectFrame, HostStaleNote } from './HostBadge';

const HOST_ID = 'devbox';
const connected: HostConnectionState = {
  status: 'connected',
  info: {
    ...fakeHostInfo(HOST_ID),
    hostVersion: DESKTOP_VERSION,
    account: { userId: 'u', environmentUrl: 'https://app.example.com' },
  },
  latencyMs: 42,
};
const offline: HostConnectionState = { status: 'offline', reason: 'unreachable', lastSeenAt: null };

let mounted: MountedHostUi | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function mountWith(state: HostConnectionState, ui: React.ReactNode, remote: Partial<FakeRemoteHostOptions> = {}) {
  const bridge = chatBackedHostBridge({ remote: { hostId: HOST_ID, label: 'devbox', state, ...remote } });
  mounted = await mountHostUi(ui, bridge);
  await settle();
  return bridge;
}

describe('host badge', () => {
  it('is absent for the local host', async () => {
    await mountWith(connected, <HostBadge hostId="local" />);
    expect(byTestId('host-badge')).toBeNull();
  });

  it('shows the host and its state beside a remote project', async () => {
    await mountWith(offline, <HostBadge hostId={HOST_ID} />);
    expect(byTestId('host-badge')?.dataset.status).toBe('offline');
    expect(textOf('host-badge-text')).toContain('offline');
  });

  it('opens a panel with state, latency, version, account and the running sessions the host reports', async () => {
    await mountWith(connected, <HostBadge hostId={HOST_ID} />, {
      statuses: [
        { sessionId: 'a', status: 'processing' },
        { sessionId: 'b', status: 'done', background: { running: 1 } },
        { sessionId: 'c', status: 'done' },
      ] as unknown as FakeRemoteHostOptions['statuses'],
    });
    await click('host-badge');
    await settle();
    expect(textOf('host-panel-state')).toBe('Connected');
    expect(textOf('host-panel-latency')).toBe('42 ms');
    expect(textOf('host-panel-version')).toBe(DESKTOP_VERSION);
    expect(textOf('host-panel-account')).toBe('u on app.example.com');
    expect(textOf('host-panel-running')).toBe('2');
    expect(byTestId('host-panel-action-reconnect-btn')).not.toBeNull();
    expect(byTestId('host-panel-action-disconnect-btn')).not.toBeNull();
  });

  it('counts running sessions from the host, not from the sessions this window loaded', async () => {
    const bridge = await mountWith(connected, <HostBadge hostId={HOST_ID} />, { statuses: [] });
    await click('host-badge');
    await settle();
    expect(bridge.remote?.requests.some(request => request.method === 'session/statuses')).toBe(true);
    expect(textOf('host-panel-running')).toBe('0');
  });

  it('says unknown, never zero, when the host cannot be asked what is running', async () => {
    await mountWith(connected, <HostBadge hostId={HOST_ID} />, { failing: ['session/statuses'] });
    await click('host-badge');
    await settle();
    expect(textOf('host-panel-running')).toBe('Unknown');
  });

  it('offers Update in the panel when the host program is older, and never Install or Remove', async () => {
    await mountWith(
      { ...connected, info: { ...connected.info, hostVersion: '1.0.0' } },
      <HostBadge hostId={HOST_ID} />
    );
    await click('host-badge');
    expect(byTestId('host-panel-action-update-btn')).not.toBeNull();
    expect(byTestId('host-panel-action-remove-btn')).toBeNull();
    expect(byTestId('host-panel-action-install-btn')).toBeNull();
  });

  it('offers no Update for a host newer than this Desktop, and says to update Desktop', async () => {
    await mountWith(
      { ...connected, info: { ...connected.info, hostVersion: '3.0.0' } },
      <HostBadge hostId={HOST_ID} />
    );
    await click('host-badge');
    expect(byTestId('host-panel-action-update-btn')).toBeNull();
    expect(textOf('host-panel-detail')).toContain('newer than this Desktop');
    expect(textOf('host-panel-detail')).toContain('Update Desktop');
    expect(textOf('host-panel-state')).toBe('Connected');
  });

  it('offers Sign in, not Reconnect, for a host that is offline because this computer is signed out', async () => {
    await mountWith({ status: 'offline', reason: 'signedOut', lastSeenAt: null }, <HostBadge hostId={HOST_ID} />);
    await click('host-badge');
    expect(byTestId('host-panel-action-reconnect-btn')).toBeNull();
    await click('host-panel-action-signInApp-btn');
    expect(mounted?.signInApp).toHaveBeenCalledTimes(1);
  });

  it('shows a failed reconnect in the panel instead of dropping it', async () => {
    const bridge = await mountWith(offline, <HostBadge hostId={HOST_ID} />);
    bridge.connect = async () => {
      throw new Error('ssh: no route to host');
    };
    await click('host-badge');
    await click('host-panel-action-reconnect-btn');
    await settle();
    expect(textOf('host-panel-action-error')).toContain('no route to host');
  });

  it('reconnects from the panel', async () => {
    const bridge = await mountWith(offline, <HostBadge hostId={HOST_ID} />);
    await click('host-badge');
    await click('host-panel-action-reconnect-btn');
    expect(bridge.management.connects).toEqual([HOST_ID]);
  });
});

describe('shared reads', () => {
  it('reads the app version from main once for every badge, chip and panel on screen', async () => {
    await mountWith(
      connected,
      <>
        <HostBadge hostId={HOST_ID} />
        <HostBadge hostId={HOST_ID} />
        <HostComposerChip hostId={HOST_ID} />
      </>
    );
    await click('host-badge');
    expect(mounted?.versionReads).toHaveBeenCalledTimes(1);
  });

  it('keeps one clock for relative times, advancing them every half minute', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1, 12, 0, 0), toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const lastSeenAt = Date.UTC(2026, 10, 1, 11, 55, 0);
      await mountWith(
        { status: 'offline', reason: 'unreachable', lastSeenAt },
        <>
          <HostBadge hostId={HOST_ID} />
          <HostComposerChip hostId={HOST_ID} />
        </>
      );
      expect(textOf('host-badge-text')).toContain('5 min ago');
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(textOf('host-badge-text')).toContain('6 min ago');
      await mounted?.unmount();
      mounted = undefined;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('offline and loading surfaces', () => {
  it('marks cached sessions stale while the host is offline, and not while connected', async () => {
    await mountWith(offline, <HostStaleNote hostId={HOST_ID} />);
    expect(textOf('host-stale-note')).toContain('Last known sessions');
    await mounted?.unmount();
    await mountWith(connected, <HostStaleNote hostId={HOST_ID} />);
    expect(byTestId('host-stale-note')).toBeNull();
  });

  it('draws skeleton rows for a host whose first list is loading', async () => {
    await mountWith(connected, <HostListPlaceholder hostId={HOST_ID} />);
    expect(byTestId('host-list-placeholder')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelectorAll('[data-testid="host-list-placeholder-row"]')).toHaveLength(3);
  });

  it('greys out a project whose host cannot take work', async () => {
    await mountWith(offline, <HostProjectFrame hostId={HOST_ID}>rows</HostProjectFrame>);
    expect(byTestId('host-project-frame')?.dataset.offline).toBe('true');
  });

  it('puts a host chip in the composer for a remote session only', async () => {
    await mountWith(
      connected,
      <>
        <HostComposerChip hostId={HOST_ID} />
        <HostComposerChip hostId="local" />
      </>
    );
    expect(allByTestId('composer-host-chip')).toHaveLength(1);
    expect(textOf('composer-host-chip')).toContain('devbox');
  });
});

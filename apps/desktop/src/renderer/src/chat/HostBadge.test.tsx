// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { HostConnectionState } from '@shared/hostConnection';
import { chatBackedHostBridge, fakeHostInfo } from '../__fixtures__/chatBackedHostBridge';
import {
  byTestId,
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

async function mountWith(state: HostConnectionState, ui: React.ReactNode) {
  const bridge = chatBackedHostBridge({ remote: { hostId: HOST_ID, label: 'devbox', state } });
  mounted = await mountHostUi(ui, bridge);
  await settle();
  return bridge;
}

describe('host badge', () => {
  it('is absent for the local host', async () => {
    await mountWith(connected, <HostBadge hostId="local" runningSessions={0} />);
    expect(byTestId('host-badge')).toBeNull();
  });

  it('shows the host and its state beside a remote project', async () => {
    await mountWith(offline, <HostBadge hostId={HOST_ID} runningSessions={0} />);
    expect(byTestId('host-badge')?.dataset.status).toBe('offline');
    expect(textOf('host-badge-text')).toContain('offline');
  });

  it('opens a panel with state, latency, version, account and running sessions', async () => {
    await mountWith(connected, <HostBadge hostId={HOST_ID} runningSessions={2} />);
    await click('host-badge');
    const panel = textOf('host-panel');
    expect(panel).toContain('Connected');
    expect(panel).toContain('42');
    expect(panel).toContain(DESKTOP_VERSION);
    expect(panel).toContain('app.example.com');
    expect(panel).toContain('2');
    expect(byTestId('host-panel-action-reconnect-btn')).not.toBeNull();
    expect(byTestId('host-panel-action-disconnect-btn')).not.toBeNull();
  });

  it('offers Update in the panel when the host program is older, and never Install or Remove', async () => {
    await mountWith(
      { ...connected, info: { ...connected.info, hostVersion: '1.0.0' } },
      <HostBadge hostId={HOST_ID} runningSessions={0} />
    );
    await click('host-badge');
    expect(byTestId('host-panel-action-update-btn')).not.toBeNull();
    expect(byTestId('host-panel-action-remove-btn')).toBeNull();
    expect(byTestId('host-panel-action-install-btn')).toBeNull();
  });

  it('reconnects from the panel', async () => {
    const bridge = await mountWith(offline, <HostBadge hostId={HOST_ID} runningSessions={0} />);
    await click('host-badge');
    await click('host-panel-action-reconnect-btn');
    expect(bridge.management.connects).toEqual([HOST_ID]);
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
    expect(document.querySelectorAll('[data-testid="composer-host-chip"]')).toHaveLength(1);
    expect(textOf('composer-host-chip')).toContain('devbox');
  });
});

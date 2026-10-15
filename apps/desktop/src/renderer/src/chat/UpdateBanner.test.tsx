import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { initialUpdateState, type UpdateBusyReport, type UpdateState } from '@shared/update';
import { UpdateBanner } from './UpdateBanner';
import { UpdateSettings } from './UpdateSettings';
import type { AppUpdateController } from './useAppUpdate';

const markup = (node: React.ReactNode) => renderToStaticMarkup(<CssVarsProvider>{node}</CssVarsProvider>);

const READY: UpdateState = {
  ...initialUpdateState('1.0.0', true),
  status: 'ready',
  version: '1.1.0',
  percent: 100,
  notes: '- a restart banner\n- <b>not markup</b>',
};

function controller(state: UpdateState, blockedBy: UpdateBusyReport | null = null): AppUpdateController {
  return {
    state,
    blockedBy,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(async () => true),
    dismissBlock: vi.fn(),
    openInstaller: vi.fn(),
  };
}

const UNSIGNED: UpdateState = {
  ...READY,
  status: 'available',
  percent: 0,
  installable: false,
  downloadUrl: 'https://example.test/Bike4Mind-1.1.0-arm64.dmg',
};

describe('UpdateBanner', () => {
  it('renders nothing until an update is staged', () => {
    for (const status of ['unsupported', 'idle', 'checking', 'available', 'downloading', 'up-to-date'] as const) {
      const html = markup(<UpdateBanner controller={controller({ ...READY, status })} onDismiss={() => {}} />);
      expect(html).not.toContain('data-testid="update-banner"');
    }
  });

  it('offers the restart, the version and a dismiss once staged', () => {
    const html = markup(<UpdateBanner controller={controller(READY)} onDismiss={() => {}} />);
    expect(html).toContain('data-testid="update-banner"');
    expect(html).toContain('Version 1.1.0 is ready');
    expect(html).toContain('data-testid="update-banner-restart-btn"');
    expect(html).toContain('Restart to update');
    expect(html).toContain('data-testid="update-banner-dismiss-btn"');
  });

  it('keeps the notes behind "What\'s new", and has no such button without notes', () => {
    const withNotes = markup(<UpdateBanner controller={controller(READY)} onDismiss={() => {}} />);
    expect(withNotes).toContain('data-testid="update-banner-notes-btn"');
    expect(withNotes).not.toContain('data-testid="update-banner-notes"');

    const without = markup(<UpdateBanner controller={controller({ ...READY, notes: null })} onDismiss={() => {}} />);
    expect(without).not.toContain('data-testid="update-banner-notes-btn"');
  });

  it('names what a restart would stop instead of restarting, once refused as busy', () => {
    const busy = { replying: 1, awaitingApproval: 0, background: 2 };
    const html = markup(<UpdateBanner controller={controller(READY, busy)} onDismiss={() => {}} />);
    expect(html).toContain('data-testid="update-banner-busy"');
    expect(html).toContain('1 session is still working and 2 background processes are running.');
    expect(html).toContain('data-testid="update-banner-force-restart-btn"');
    expect(html).toContain('data-testid="update-banner-keep-btn"');
    expect(html).not.toContain('data-testid="update-banner-restart-btn"');
  });
});

describe('UpdateBanner in a build that cannot install updates', () => {
  it('offers the installer download instead of a restart', () => {
    const html = markup(<UpdateBanner controller={controller(UNSIGNED)} onDismiss={() => {}} />);
    expect(html).toContain('Version 1.1.0 is available');
    expect(html).toContain('data-testid="update-banner-unsigned"');
    expect(html).toContain('code-signed build');
    expect(html).toContain('data-testid="update-banner-download-btn"');
    expect(html).not.toContain('data-testid="update-banner-restart-btn"');
  });

  it('still explains itself when the feed named no installer for this machine', () => {
    const html = markup(
      <UpdateBanner controller={controller({ ...UNSIGNED, downloadUrl: null })} onDismiss={() => {}} />
    );
    expect(html).toContain('data-testid="update-banner-unsigned"');
    expect(html).not.toContain('data-testid="update-banner-download-btn"');
  });
});

describe('UpdateSettings in a build that cannot install updates', () => {
  it('replaces Download with the installer download and says why', () => {
    const html = markup(<UpdateSettings controller={controller(UNSIGNED)} />);
    expect(html).toContain('data-testid="update-unsigned-note"');
    expect(html).toContain('data-testid="update-installer-btn"');
    expect(html).not.toContain('data-testid="update-download-btn"');
  });

  it('keeps Download for an installable offer', () => {
    const html = markup(
      <UpdateSettings controller={controller({ ...UNSIGNED, installable: true, downloadUrl: null })} />
    );
    expect(html).toContain('data-testid="update-download-btn"');
    expect(html).not.toContain('data-testid="update-unsigned-note"');
  });
});

describe('UpdateSettings release notes', () => {
  it('shows the notes as text for an offered or staged update', () => {
    const html = markup(<UpdateSettings controller={controller(READY)} />);
    expect(html).toContain('data-testid="update-notes"');
    expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;');
    expect(html).toContain('data-testid="update-install-btn"');
  });

  it('shows no notes once the feed says the app is current', () => {
    const html = markup(
      <UpdateSettings controller={controller({ ...READY, status: 'up-to-date', version: null, notes: 'stale' })} />
    );
    expect(html).not.toContain('data-testid="update-notes"');
  });
});

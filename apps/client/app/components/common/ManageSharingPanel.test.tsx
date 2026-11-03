import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), patch: vi.fn().mockResolvedValue({ data: {} }) },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { ManageSharingPanel } from './ManageSharingPanel';

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderPanel = async (artifact: Record<string, unknown>, visibility = 'public') => {
  apiGet.mockClear().mockResolvedValue({ data: { artifact } });
  render(
    <Wrapper>
      <ManageSharingPanel
        publicId="pub-1"
        title="My Artifact"
        shareUrl="https://app.x/p/u/u1/s"
        visibility={visibility}
      />
    </Wrapper>
  );
  await screen.findByTestId('manage-sharing-panel');
};

describe('ManageSharingPanel', () => {
  beforeEach(() => {
    (api.patch as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({ data: {} });
  });

  it('open-public: shows share row, gate editor, and the embed editor', async () => {
    await renderPanel({ visibility: 'public', accessGate: null, embedOrigins: [], commentPolicy: 'none' });
    expect(screen.getByTestId('share-actions')).not.toBeNull();
    expect(screen.getByTestId('manage-gate-section')).not.toBeNull();
    expect(screen.getByTestId('manage-embed-section')).not.toBeNull();
  });

  it('gated: hides the embed editor (embedding is open-public only)', async () => {
    await renderPanel({
      visibility: 'public',
      accessGate: { kind: 'domain', allowedDomains: ['milliononmars.com'] },
      embedOrigins: [],
      commentPolicy: 'none',
    });
    expect(screen.getByTestId('manage-gate-section')).not.toBeNull();
    expect(screen.queryByTestId('manage-embed-section')).toBeNull();
  });

  it('tells the parent about an applied gate, so the row badge can follow it', async () => {
    const onGateChange = vi.fn();
    apiGet.mockClear().mockResolvedValue({
      data: { artifact: { visibility: 'public', accessGate: null, embedOrigins: [], commentPolicy: 'none' } },
    });
    render(
      <Wrapper>
        <ManageSharingPanel
          publicId="pub-1"
          title="My Artifact"
          shareUrl="https://app.x/p/u/u1/s"
          visibility="public"
          onGateChange={onGateChange}
        />
      </Wrapper>
    );
    await screen.findByTestId('manage-sharing-panel');

    fireEvent.click(screen.getByTestId('manage-gate-domain'));
    fireEvent.change(screen.getByTestId('manage-gate-domains-input'), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));

    await waitFor(() => expect(onGateChange).toHaveBeenCalledWith({ kind: 'domain', allowedDomains: ['acme.com'] }));
    // The panel's own state moved too: a gated page has no embed editor.
    expect(screen.queryByTestId('manage-embed-section')).toBeNull();
  });

  it('does not tell the parent about a gate when the save fails', async () => {
    const onGateChange = vi.fn();
    (api.patch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('x'));
    apiGet.mockClear().mockResolvedValue({
      data: { artifact: { visibility: 'public', accessGate: null, embedOrigins: [], commentPolicy: 'none' } },
    });
    render(
      <Wrapper>
        <ManageSharingPanel
          publicId="pub-1"
          title="My Artifact"
          shareUrl="https://app.x/p/u/u1/s"
          visibility="public"
          onGateChange={onGateChange}
        />
      </Wrapper>
    );
    await screen.findByTestId('manage-sharing-panel');

    fireEvent.click(screen.getByTestId('manage-gate-domain'));
    fireEvent.change(screen.getByTestId('manage-gate-domains-input'), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onGateChange).not.toHaveBeenCalled();
  });

  it('private with a stored gate: shows it, and clearing it tells the parent so the row badge can follow', async () => {
    const onGateChange = vi.fn();
    const apiPatch = api.patch as unknown as ReturnType<typeof vi.fn>;
    apiPatch.mockClear().mockResolvedValue({ data: {} });
    apiGet.mockClear().mockResolvedValue({
      data: {
        artifact: {
          visibility: 'private',
          accessGate: { kind: 'passphrase' },
          embedOrigins: [],
          commentPolicy: 'none',
        },
      },
    });
    render(
      <Wrapper>
        <ManageSharingPanel
          publicId="pub-1"
          title="My Artifact"
          shareUrl="https://app.x/p/u/u1/s"
          visibility="private"
          onGateChange={onGateChange}
        />
      </Wrapper>
    );
    await screen.findByTestId('manage-sharing-panel');

    expect(screen.getByTestId('manage-gate-private-link-note')).not.toBeNull();
    expect(screen.queryByTestId('manage-gate-needs-public')).toBeNull();

    fireEvent.click(screen.getByTestId('manage-gate-clear'));
    fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { accessGate: null }));
    await waitFor(() => expect(onGateChange).toHaveBeenCalledWith(null));
    await waitFor(() => expect(screen.getByTestId('manage-gate-needs-public')).not.toBeNull());
    expect(screen.queryByTestId('manage-gate-clear')).toBeNull();
  });

  it('private: hides embed and shows the gate needs-public hint', async () => {
    await renderPanel({ visibility: 'private', accessGate: null, embedOrigins: [], commentPolicy: 'none' }, 'private');
    expect(screen.queryByTestId('manage-embed-section')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('manage-gate-needs-public')).not.toBeNull());
  });
});

describe('ManageSharingPanel — search-listing toggle', () => {
  it('seeds the toggle ON from a listed artifact', async () => {
    // Pins setInitialDiscoverable: without it the switch renders OFF for an artifact
    // that is genuinely listed, and the owner sees a state that is not the truth.
    await renderPanel({
      visibility: 'public',
      accessGate: null,
      embedOrigins: [],
      commentPolicy: 'none',
      discoverable: true,
    });
    const toggle = screen.getByTestId('manage-discoverable-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('seeds the toggle OFF for an artifact that never opted in', async () => {
    await renderPanel({ visibility: 'public', accessGate: null, embedOrigins: [], commentPolicy: 'none' });
    const toggle = screen.getByTestId('manage-discoverable-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('hides the toggle for a gated artifact (it could never take effect)', async () => {
    await renderPanel({
      visibility: 'public',
      accessGate: { kind: 'passphrase' },
      embedOrigins: [],
      commentPolicy: 'none',
      discoverable: true,
    });
    expect(screen.queryByTestId('manage-discoverable-toggle')).toBeNull();
  });

  it('hides the toggle for a private artifact', async () => {
    await renderPanel({ visibility: 'private', accessGate: null, embedOrigins: [], commentPolicy: 'none' }, 'private');
    expect(screen.queryByTestId('manage-discoverable-toggle')).toBeNull();
  });
});

/** Helper text is dimmed by a theme text token, never `opacity`, which stacks on the token and drops it below AA. */
const expectTokenDimmed = (el: HTMLElement, token: 'secondary' | 'tertiary') => {
  const style = getComputedStyle(el);
  expect(['', '1']).toContain(style.opacity);
  expect(style.color).toContain(`--joy-palette-text-${token}`);
};

describe('ManageSharingPanel - helper text contrast', () => {
  it('dims the search-listing, embed and passphrase helper text with a text token, not opacity', async () => {
    await renderPanel({ visibility: 'public', accessGate: null, embedOrigins: ['example.com'], commentPolicy: 'none' });
    expectTokenDimmed(screen.getByText(/Off by default\. When off/), 'tertiary');
    expectTokenDimmed(screen.getByText(/Let specific websites show this artifact/), 'tertiary');
    expectTokenDimmed(screen.getByText(/Paste this where you want the artifact to appear/), 'tertiary');
    fireEvent.click(screen.getByTestId('manage-gate-passphrase'));
    expectTokenDimmed(screen.getByText(/Stored hashed - it cannot be shown again/), 'tertiary');
  });

  it('dims the needs-public hint with a text token, not opacity', async () => {
    await renderPanel({ visibility: 'private', accessGate: null, embedOrigins: [], commentPolicy: 'none' }, 'private');
    expectTokenDimmed(screen.getByTestId('manage-gate-needs-public'), 'tertiary');
  });
});

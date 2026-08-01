import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), patch: vi.fn().mockResolvedValue({ data: {} }) },
}));
import { api } from '@client/app/contexts/ApiContext';
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

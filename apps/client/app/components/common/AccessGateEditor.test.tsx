import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { patch: vi.fn().mockResolvedValue({ data: {} }) },
}));
import { api } from '@client/app/contexts/ApiContext';
import { AccessGateEditor } from './AccessGateEditor';
import type { PublishAccessGateRead } from '@client/app/utils/publishApi';

const apiPatch = api.patch as unknown as ReturnType<typeof vi.fn>;
const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderEditor = (visibility = 'public', initialGate: PublishAccessGateRead = null) => {
  apiPatch.mockClear().mockResolvedValue({ data: {} });
  render(
    <Wrapper>
      <AccessGateEditor publicId="pub-1" visibility={visibility} initialGate={initialGate} />
    </Wrapper>
  );
};

// The whole card is the click target (the Radio inside is a pointer-events-none
// visual), so select by clicking the option card, not the radio input.
const pickGate = (kind: string) => fireEvent.click(screen.getByTestId(`manage-gate-${kind}`));

describe('AccessGateEditor', () => {
  it('shows the needs-public hint when the artifact is not public', () => {
    renderEditor('private');
    expect(screen.getByTestId('manage-gate-needs-public')).not.toBeNull();
  });

  it('applies a domain gate with a normalized, deduped list', async () => {
    renderEditor('public');
    pickGate('domain');
    fireEvent.change(screen.getByTestId('manage-gate-domains-input'), {
      target: { value: 'MillionOnMars.com, bike4mind.com milliononmars.com' },
    });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        accessGate: { kind: 'domain', allowedDomains: ['milliononmars.com', 'bike4mind.com'] },
      })
    );
  });

  it('reduces a subdomain entry to its registrable domain (eTLD+1) before PATCH', async () => {
    renderEditor('public');
    pickGate('domain');
    fireEvent.change(screen.getByTestId('manage-gate-domains-input'), {
      target: { value: 'mail.acme.com' },
    });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        accessGate: { kind: 'domain', allowedDomains: ['acme.com'] },
      })
    );
  });

  it('rejects a bare public suffix (co.uk) without a PATCH', () => {
    renderEditor('public');
    pickGate('domain');
    fireEvent.change(screen.getByTestId('manage-gate-domains-input'), {
      target: { value: 'co.uk' },
    });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('rejects a too-short passphrase without a PATCH', () => {
    renderEditor('public');
    pickGate('passphrase');
    fireEvent.change(screen.getByTestId('manage-gate-passphrase-input'), { target: { value: 'short' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('applies a valid passphrase gate', async () => {
    renderEditor('public');
    pickGate('passphrase');
    fireEvent.change(screen.getByTestId('manage-gate-passphrase-input'), { target: { value: 'longenough1' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        accessGate: { kind: 'passphrase', passphrase: 'longenough1' },
      })
    );
  });

  it('removes the gate when None is applied (accessGate: null)', async () => {
    renderEditor('public', { kind: 'passphrase' });
    pickGate('none');
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { accessGate: null }));
  });
});

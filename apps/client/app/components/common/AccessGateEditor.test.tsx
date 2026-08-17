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

  it('sends a subdomain entry AS ENTERED (not reduced to its parent)', async () => {
    renderEditor('public');
    pickGate('domain');
    fireEvent.change(screen.getByTestId('manage-gate-domains-input'), {
      target: { value: 'mail.acme.com' },
    });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        accessGate: { kind: 'domain', allowedDomains: ['mail.acme.com'] },
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

/**
 * Show-once. The passphrase is bcrypt-hashed server-side and returned by no route, so the
 * moment just after Apply is the only one in which the plaintext exists anywhere the owner can
 * see it. These cover that it is actually shown then - and, just as importantly, that it does
 * not linger or get mistaken for a readable stored value.
 */
describe('AccessGateEditor - passphrase show-once', () => {
  const input = () => screen.getByTestId('manage-gate-passphrase-input') as HTMLInputElement;

  it('generates a passphrase and unmasks it, since one you cannot read is useless', () => {
    renderEditor('public');
    pickGate('passphrase');
    expect(input().type).toBe('password');

    fireEvent.click(screen.getByTestId('manage-gate-passphrase-generate'));

    expect(input().value).toMatch(/^[a-z]+-[a-z]+-\d{2}-[a-z]+-[a-z]+$/);
    expect(input().type).toBe('text');
  });

  it('toggles masking of what is being typed', () => {
    renderEditor('public');
    pickGate('passphrase');
    fireEvent.change(input(), { target: { value: 'longenough1' } });
    expect(input().type).toBe('password');

    fireEvent.click(screen.getByTestId('manage-gate-passphrase-reveal'));
    expect(input().type).toBe('text');

    fireEvent.click(screen.getByTestId('manage-gate-passphrase-reveal'));
    expect(input().type).toBe('password');
  });

  it('displays the applied passphrase once, and clears it from the input', async () => {
    renderEditor('public');
    pickGate('passphrase');
    fireEvent.change(input(), { target: { value: 'ravine-cobalt-79-mist-opal' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));

    await waitFor(() => expect(screen.getByTestId('manage-gate-passphrase-justset')).not.toBeNull());
    expect(screen.getByTestId('manage-gate-passphrase-justset-value').textContent).toBe('ravine-cobalt-79-mist-opal');
    // The input is emptied and re-masked, so the value survives only in the show-once panel.
    expect(input().value).toBe('');
    expect(input().type).toBe('password');
  });

  it('does not show the panel for a domain gate', async () => {
    renderEditor('public');
    pickGate('domain');
    fireEvent.change(screen.getByTestId('manage-gate-domains-input'), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));

    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(screen.queryByTestId('manage-gate-passphrase-justset')).toBeNull();
  });

  it('drops the shown passphrase as soon as a new one is typed', async () => {
    renderEditor('public');
    pickGate('passphrase');
    fireEvent.change(input(), { target: { value: 'longenough1' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() => expect(screen.getByTestId('manage-gate-passphrase-justset')).not.toBeNull());

    fireEvent.change(input(), { target: { value: 'a' } });

    expect(screen.queryByTestId('manage-gate-passphrase-justset')).toBeNull();
  });

  // Setting the first passphrase and replacing a live one have different consequences: the
  // second revokes access for everyone already holding the old value. The affordance has to say
  // so, because a forgotten passphrase leaves replacement as the ONLY route and the person doing
  // it may not realise they are cutting off existing viewers.
  it('offers "Generate" when no passphrase is set yet', () => {
    renderEditor('public');
    pickGate('passphrase');
    expect(screen.getByTestId('manage-gate-passphrase-generate').textContent).toContain('Generate');
  });

  it('offers "Replace" and warns about revocation when a passphrase is already set', () => {
    renderEditor('public', { kind: 'passphrase' });

    const button = screen.getByTestId('manage-gate-passphrase-generate');
    expect(button.textContent).toContain('Replace');
    expect(screen.getByText(/cannot be shown or recovered/i)).not.toBeNull();
    expect(screen.getByText(/stops the old one working/i)).not.toBeNull();
  });

  it('switches to the replace framing after the first passphrase is applied', async () => {
    // The parent is notified but need not feed a new initialGate back, so this must not depend
    // on the prop changing.
    renderEditor('public');
    pickGate('passphrase');
    expect(screen.getByTestId('manage-gate-passphrase-generate').textContent).toContain('Generate');

    fireEvent.change(input(), { target: { value: 'longenough1' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));

    await waitFor(() => expect(screen.getByTestId('manage-gate-passphrase-generate').textContent).toContain('Replace'));
  });

  it('drops the replace framing when the gate is removed', async () => {
    renderEditor('public', { kind: 'passphrase' });
    pickGate('none');
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());

    pickGate('passphrase');
    expect(screen.getByTestId('manage-gate-passphrase-generate').textContent).toContain('Generate');
  });

  it('copies the shown passphrase to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderEditor('public');
    pickGate('passphrase');
    fireEvent.change(input(), { target: { value: 'longenough1' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() => expect(screen.getByTestId('manage-gate-passphrase-justset')).not.toBeNull());

    fireEvent.click(screen.getByTestId('manage-gate-passphrase-copy'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('longenough1'));
  });
});

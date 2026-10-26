import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { patch: vi.fn().mockResolvedValue({ data: {} }) },
}));
import { api } from '@client/app/contexts/ApiContext';
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from 'sonner';
import { AccessGateEditor } from './AccessGateEditor';
import type { PublishAccessGateRead } from '@client/app/utils/publishApi';

const apiPatch = api.patch as unknown as ReturnType<typeof vi.fn>;
const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderEditor = (
  visibility = 'public',
  initialGate: PublishAccessGateRead = null,
  onGateChange?: (gate: PublishAccessGateRead) => void
) => {
  apiPatch.mockClear().mockResolvedValue({ data: {} });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  render(
    <Wrapper>
      <AccessGateEditor
        publicId="pub-1"
        visibility={visibility}
        initialGate={initialGate}
        onGateChange={onGateChange}
      />
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

  // The show-once panel renders as a SIBLING of the passphrase block, so it survives a change of
  // gate type - and that change also removes the input, which was the only other thing that
  // cleared it. The plaintext therefore stayed on screen indefinitely, under a heading reading
  // "This will not be shown again", for anyone comparing gate options over a screen share.
  it('clears the shown passphrase when the gate type changes', async () => {
    renderEditor('public');
    pickGate('passphrase');
    fireEvent.change(input(), { target: { value: 'longenough1' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() => expect(screen.getByTestId('manage-gate-passphrase-justset')).not.toBeNull());

    pickGate('domain');

    expect(screen.queryByTestId('manage-gate-passphrase-justset')).toBeNull();
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

/**
 * A gate stored on a private, team or project page is still enforced on that page's private share
 * links, so the owner has to be able to see it and clear it. The editor says so only while a gate
 * is stored; with none, a non-public page keeps the hint that gates are a public-page setting.
 */
describe('AccessGateEditor - a gate stored on a non-public page', () => {
  const clickClear = () => fireEvent.click(screen.getByTestId('manage-gate-clear'));
  const confirmClear = () => fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));

  it.each(['private', 'organization', 'project'])(
    'shows a stored passphrase gate on a %s page with what it guards and a Clear action',
    visibility => {
      renderEditor(visibility, { kind: 'passphrase' });

      const note = screen.getByTestId('manage-gate-private-link-note');
      expect(note.textContent).toContain('Passphrase gate');
      expect(note.textContent).toContain('Private links to this page need the passphrase.');
      expect(screen.getByTestId('manage-gate-clear')).not.toBeNull();
      expect(screen.queryByTestId('manage-gate-needs-public')).toBeNull();
    }
  );

  it('never reveals the stored passphrase: only a write-only input and the cannot-be-shown line', () => {
    renderEditor('private', { kind: 'passphrase' });

    expect((screen.getByTestId('manage-gate-passphrase-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/cannot be shown or recovered/i)).not.toBeNull();
    expect(screen.queryByTestId('manage-gate-passphrase-justset')).toBeNull();
  });

  it('shows a stored domain gate with its allowed domains and the domain wording', () => {
    renderEditor('private', { kind: 'domain', allowedDomains: ['acme.com', 'example.org'] });

    expect(screen.getByTestId('manage-gate-private-link-note').textContent).toContain('Email domain gate');
    expect(screen.getByTestId('manage-gate-private-link-note').textContent).toContain(
      'Private links to this page need a verified email from an allowed domain.'
    );
    expect((screen.getByTestId('manage-gate-domains-input') as HTMLTextAreaElement).value).toBe(
      'acme.com, example.org'
    );
  });

  // checkVisibility runs no stored gate on /p/..., so the note names who still opens the page
  // itself without one, per visibility, rather than implying the page is gated too.
  it.each([
    ['organization', 'Team members who open the page itself, not a private link, are not asked for it.'],
    ['project', 'Project members who open the page itself, not a private link, are not asked for it.'],
    ['private', 'The page itself, not a private link, still opens only for you.'],
  ])('on a %s page, says who opens the page itself without the gate', (visibility, sentence) => {
    renderEditor(visibility, { kind: 'passphrase' });

    const note = screen.getByTestId('manage-gate-private-link-note').textContent ?? '';
    expect(note).toContain(sentence);
    expect(note).not.toMatch(/also need/);
  });

  it('offers the stored gate types but not "Anyone with the link", which is the Clear action here', () => {
    renderEditor('private', { kind: 'passphrase' });

    expect(screen.getByTestId('manage-gate-passphrase')).not.toBeNull();
    expect(screen.getByTestId('manage-gate-domain')).not.toBeNull();
    expect(screen.queryByTestId('manage-gate-none')).toBeNull();
  });

  it('asks before clearing, and sends nothing until the owner confirms', async () => {
    renderEditor('private', { kind: 'passphrase' });

    clickClear();

    expect(screen.getByTestId('confirmation-dialog').textContent).toContain('cannot be recovered');
    expect(apiPatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirmation-cancel-btn'));
    expect(screen.queryByTestId('confirmation-dialog')).toBeNull();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('manage-gate-private-link-note')).not.toBeNull();
  });

  it('clears through the same API a public Remove gate uses, tells the parent, and drops back to the hint', async () => {
    const onGateChange = vi.fn();
    renderEditor('private', { kind: 'passphrase' }, onGateChange);

    clickClear();
    confirmClear();

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { accessGate: null }));
    await waitFor(() => expect(onGateChange).toHaveBeenCalledWith(null));
    await waitFor(() => expect(screen.getByTestId('manage-gate-needs-public')).not.toBeNull());
    expect(screen.queryByTestId('manage-gate-clear')).toBeNull();
    expect(screen.queryByTestId('manage-gate-private-link-note')).toBeNull();
    expect(screen.queryByTestId('confirmation-dialog')).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('Gate cleared - private links no longer ask for it');
  });

  it('lands focus on the hint after a clear, since the Clear button it came from is gone', async () => {
    renderEditor('private', { kind: 'passphrase' });
    screen.getByTestId('manage-gate-clear').focus();

    clickClear();
    confirmClear();

    const hint = await screen.findByTestId('manage-gate-needs-public');
    await waitFor(() => expect(document.activeElement).toBe(hint));
    // The owner just read that the gate guarded private links, so the hint must not say gates
    // only apply to public pages.
    expect(hint.textContent).toBe('To add a passphrase or domain restriction here, set visibility to Public.');
  });

  it('says what clearing a domain gate opens up: private links with no sign-in at all', () => {
    renderEditor('organization', { kind: 'domain', allowedDomains: ['acme.com'] });

    clickClear();

    expect(screen.getByTestId('confirmation-dialog').textContent).toContain(
      'Anyone with a private link to this page will open it without signing in.'
    );
  });

  it('offers no unconfirmed Remove gate when a public "Anyone with the link" draft carries over to a non-public page', () => {
    apiPatch.mockClear();
    const ui = (visibility: string) => (
      <Wrapper>
        <AccessGateEditor publicId="pub-1" visibility={visibility} initialGate={{ kind: 'passphrase' }} />
      </Wrapper>
    );
    const { rerender } = render(ui('public'));
    pickGate('none');
    expect(screen.getByTestId('manage-gate-apply').textContent).toBe('Remove gate');

    rerender(ui('private'));

    expect(screen.queryByTestId('manage-gate-apply')).toBeNull();
    expect(screen.getByTestId('manage-gate-clear')).not.toBeNull();
    pickGate('passphrase');
    expect(screen.getByTestId('manage-gate-apply').textContent).toBe('Apply');
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('keeps the stored gate and the parent untouched when the server refuses the clear', async () => {
    const onGateChange = vi.fn();
    renderEditor('private', { kind: 'domain', allowedDomains: ['acme.com'] }, onGateChange);
    apiPatch.mockRejectedValueOnce(new Error('Network down'));

    clickClear();
    confirmClear();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Network down'));
    expect(onGateChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirmation-dialog')).toBeNull();
    expect(screen.getByTestId('manage-gate-private-link-note')).not.toBeNull();
    expect((screen.getByTestId('manage-gate-domains-input') as HTMLTextAreaElement).value).toBe('acme.com');
  });

  it('lets the owner change a stored gate: a replacement goes through the ordinary apply', async () => {
    const onGateChange = vi.fn();
    renderEditor('private', { kind: 'passphrase' }, onGateChange);

    pickGate('domain');
    fireEvent.change(screen.getByTestId('manage-gate-domains-input'), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        accessGate: { kind: 'domain', allowedDomains: ['acme.com'] },
      })
    );
    await waitFor(() => expect(onGateChange).toHaveBeenCalledWith({ kind: 'domain', allowedDomains: ['acme.com'] }));
    // Still stored, so the note follows the new kind.
    expect(screen.getByTestId('manage-gate-private-link-note').textContent).toContain('Email domain gate');
  });

  it('shows the hint, not an editor or a Clear action, when no gate is stored', () => {
    renderEditor('private', null);

    expect(screen.getByTestId('manage-gate-needs-public')).not.toBeNull();
    expect(screen.queryByTestId('manage-gate-clear')).toBeNull();
    expect(screen.queryByTestId('manage-gate-private-link-note')).toBeNull();
    expect(screen.queryByTestId('manage-gate-apply')).toBeNull();
  });

  it('leaves a public page as it was: every option, Remove gate for none, no private-link note or Clear', () => {
    renderEditor('public', { kind: 'passphrase' });

    expect(screen.getByTestId('manage-gate-none')).not.toBeNull();
    expect(screen.queryByTestId('manage-gate-private-link-note')).toBeNull();
    expect(screen.queryByTestId('manage-gate-clear')).toBeNull();
    expect(screen.queryByTestId('manage-gate-needs-public')).toBeNull();

    pickGate('none');
    expect(screen.getByTestId('manage-gate-apply').textContent).toBe('Remove gate');
  });

  it('keeps the public removal toast as it was', async () => {
    renderEditor('public', { kind: 'passphrase' });
    pickGate('none');
    fireEvent.click(screen.getByTestId('manage-gate-apply'));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Gate removed - open to anyone with the link'));
  });
});

describe('AccessGateEditor - helper text contrast', () => {
  /** Opacity stacks on the text token and drops helper text below AA, including inside the tinted show-once note. */
  const expectTokenDimmed = (el: HTMLElement) => {
    const style = getComputedStyle(el);
    expect(['', '1']).toContain(style.opacity);
    expect(style.color).toContain('--joy-palette-text-tertiary');
  };

  it('dims the live-gate passphrase hint with a text token, not opacity', () => {
    renderEditor('public', { kind: 'passphrase' });
    expectTokenDimmed(screen.getByText(/A passphrase is set\. It cannot be shown or recovered/));
  });

  it('dims the show-once note hint with a text token, not opacity', async () => {
    renderEditor('public');
    pickGate('passphrase');
    fireEvent.change(screen.getByTestId('manage-gate-passphrase-input'), { target: { value: 'longenough1' } });
    fireEvent.click(screen.getByTestId('manage-gate-apply'));
    await waitFor(() => expect(screen.getByTestId('manage-gate-passphrase-justset')).not.toBeNull());
    expectTokenDimmed(screen.getByText(/This will not be shown again/));
  });
});

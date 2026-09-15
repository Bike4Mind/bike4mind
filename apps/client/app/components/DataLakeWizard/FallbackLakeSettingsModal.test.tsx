import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { FallbackLakeSettingsModal } from './FallbackLakeSettingsModal';

const updateMutate = vi.fn();

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useUpdateFallbackLakeSettings: () => ({ mutate: updateMutate, isPending: false }),
}));

// Same seam as DataLakeSettingsModal.test.tsx: the picker's options come from an async
// react-query hook, mocked so the modal renders without a QueryClientProvider and each test can
// control the two states that matter (not-yet-arrived vs loaded).
type MockActivatable = { promptId: string; name: string; description: string };
let activatablePrompts: MockActivatable[] | undefined;
let activatableLoading = false;
let activatableError = false;
vi.mock('@client/app/hooks/data/useActivatablePrompts', () => ({
  useActivatablePrompts: () => ({ data: activatablePrompts, isLoading: activatableLoading, isError: activatableError }),
}));

const TRIAGE_ROUTER: MockActivatable = {
  promptId: 'triage_router',
  name: 'Triage Router',
  description: 'Grounding-first routing prompt.',
};

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const lake = {
  id: 'opti-knowledge',
  name: 'OptiHashi Knowledge',
  groundingMode: 'retrieve' as const,
  preferredSystemPromptId: '',
  systemPrompt: '',
  organizationId: '',
};

beforeEach(() => {
  updateMutate.mockClear();
  activatablePrompts = [TRIAGE_ROUTER];
  activatableLoading = false;
  activatableError = false;
});

describe('FallbackLakeSettingsModal', () => {
  it('renders nothing (closed) when no lake is being edited', () => {
    render(<FallbackLakeSettingsModal lake={null} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('fallback-lake-settings-modal')).not.toBeInTheDocument();
  });

  it('seeds the grounding-mode picker from the lake and saves the CHANGED value only', async () => {
    const user = userEvent.setup();
    render(<FallbackLakeSettingsModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('fallback-lake-grounding-mode-button')).toHaveTextContent('Retrieve (recommended)');

    await user.click(screen.getByTestId('fallback-lake-grounding-mode-button'));
    await user.click(screen.getByTestId('fallback-lake-grounding-mode-inline'));
    await user.click(screen.getByTestId('fallback-lake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'opti-knowledge', groundingMode: 'inline' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('seeds the preferred-prompt picker as None when unbound, and sends nothing if unchanged', async () => {
    const user = userEvent.setup();
    render(<FallbackLakeSettingsModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('fallback-lake-preferred-prompt-button')).toHaveTextContent('None');

    await user.click(screen.getByTestId('fallback-lake-settings-save-btn'));

    // Nothing moved at all, so the body carries the id and nothing else - the server's own
    // no-field early-out then makes the whole save a no-op.
    expect(updateMutate).toHaveBeenCalledWith({ id: 'opti-knowledge' }, expect.anything());
  });

  it('binds a prompt from the picker and sends the new id', async () => {
    const user = userEvent.setup();
    render(<FallbackLakeSettingsModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    await user.click(screen.getByTestId('fallback-lake-preferred-prompt-button'));
    await user.click(screen.getByTestId('fallback-lake-preferred-prompt-triage_router'));
    await user.click(screen.getByTestId('fallback-lake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'opti-knowledge', preferredSystemPromptId: 'triage_router' },
      expect.anything()
    );
  });

  it('clearing a bound prompt back to None sends the "" clear sentinel', async () => {
    const user = userEvent.setup();
    const bound = { ...lake, preferredSystemPromptId: 'triage_router' };
    render(<FallbackLakeSettingsModal lake={bound} onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('fallback-lake-preferred-prompt-button')).toHaveTextContent('Triage Router');

    await user.click(screen.getByTestId('fallback-lake-preferred-prompt-button'));
    await user.click(screen.getByTestId('fallback-lake-preferred-prompt-none'));
    await user.click(screen.getByTestId('fallback-lake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledWith({ id: 'opti-knowledge', preferredSystemPromptId: '' }, expect.anything());
  });

  it('keeps a delisted bound prompt visible via the fallback Option, and does not clear it on an unrelated save', async () => {
    activatablePrompts = []; // TRIAGE_ROUTER has been delisted server-side
    const user = userEvent.setup();
    const bound = { ...lake, preferredSystemPromptId: 'triage_router' };
    render(<FallbackLakeSettingsModal lake={bound} onClose={vi.fn()} />, { wrapper: Wrapper });

    // The delisted id still renders (as itself, since the loading state has already resolved).
    expect(screen.getByTestId('fallback-lake-preferred-prompt-button')).toHaveTextContent('triage_router');

    await user.click(screen.getByTestId('fallback-lake-settings-save-btn'));

    // Unchanged (still bound to the same, now-delisted id) - omitted, never re-sent to 400.
    expect(updateMutate).toHaveBeenCalledWith({ id: 'opti-knowledge' }, expect.anything());
  });

  it('seeds the system prompt textarea from the lake and sends the trimmed value when it changed', async () => {
    const user = userEvent.setup();
    render(<FallbackLakeSettingsModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    const textarea = screen.getByTestId('fallback-lake-systemprompt-input').querySelector('textarea')!;
    expect(textarea).toHaveValue('');

    await user.type(textarea, '  Answer only from this lake.  ');
    await user.click(screen.getByTestId('fallback-lake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'opti-knowledge', systemPrompt: 'Answer only from this lake.' },
      expect.anything()
    );
  });

  // The reason every field is conditioned on change for THIS lake kind. A registry lake's settings
  // come from a separate overlay read that degrades to "nothing set" while the lake still renders,
  // so the modal can legitimately be seeded blank while real values sit in the store. Saving an
  // unrelated field must not carry that blank seed back over them.
  it('does not send an untouched systemPrompt, so a degraded seed cannot clobber a stored prompt', async () => {
    const user = userEvent.setup();
    // What a failed overlay read looks like to this component: coded defaults, blank prompt.
    render(<FallbackLakeSettingsModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    await user.click(screen.getByTestId('fallback-lake-grounding-mode-button'));
    await user.click(screen.getByTestId('fallback-lake-grounding-mode-inline'));
    await user.click(screen.getByTestId('fallback-lake-settings-save-btn'));

    const body = updateMutate.mock.calls[0][0];
    expect(body).not.toHaveProperty('systemPrompt');
    expect(body).not.toHaveProperty('preferredSystemPromptId');
    expect(body).toEqual({ id: 'opti-knowledge', groundingMode: 'inline' });
  });

  it("warns that a GATELESS (no organizationId) lake's prompt is stored but never injected", () => {
    render(<FallbackLakeSettingsModal lake={{ ...lake, organizationId: '' }} onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByTestId('fallback-lake-systemprompt-help')).toHaveTextContent(/never injected/i);
  });

  it('does NOT warn for an org-scoped lake - the prompt IS active for that org', () => {
    render(<FallbackLakeSettingsModal lake={{ ...lake, organizationId: 'org-alpha' }} onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByTestId('fallback-lake-systemprompt-help')).not.toHaveTextContent(/never injected/i);
  });

  it('does NOT offer name/description/visibility/gate fields - a fallback lake has no document for them', () => {
    render(<FallbackLakeSettingsModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.queryByTestId('datalake-settings-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-settings-visibility')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-settings-usertag')).not.toBeInTheDocument();
  });

  it('closes without saving on Cancel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<FallbackLakeSettingsModal lake={lake} onClose={onClose} />, { wrapper: Wrapper });

    await user.click(screen.getByText('Cancel'));

    expect(updateMutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

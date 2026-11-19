// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockGenerateNewSession, mockNavigate, setProgrammaticLaunch, mockToastError, pickState, featureState } =
  vi.hoisted(() => ({
    mockGenerateNewSession: vi.fn(),
    mockNavigate: vi.fn(),
    setProgrammaticLaunch: vi.fn(),
    mockToastError: vi.fn(),
    pickState: { file: null as { id: string; fileName: string } | null },
    featureState: { agentMode: true },
  }));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isFeatureEnabled: (feature: string) => feature === 'agentMode' && featureState.agentMode,
  }),
}));
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@client/app/utils/sessionsAPICalls', () => ({ generateNewSession: mockGenerateNewSession }));
vi.mock('@client/app/hooks/data/sessions', () => ({ updateSessionsQueryData: vi.fn() }));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: (selector: (state: { setProgrammaticLaunch: typeof setProgrammaticLaunch }) => unknown) =>
    selector({ setProgrammaticLaunch }),
}));
// The real picker pulls in the whole Files browser; a stub that "picks" the configured file is enough here.
vi.mock('@client/app/components/Files/EmbeddedFileBrowser', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  const Stub = forwardRef<{ handleOpen: () => void }, { onAdd?: (files: unknown[]) => void }>(({ onAdd }, ref) => {
    useImperativeHandle(ref, () => ({ handleOpen: () => onAdd?.(pickState.file ? [pickState.file] : []) }), [onAdd]);
    return null;
  });
  return { default: Stub };
});

import DirectButton from './DirectButton';
import { DIRECTOR_TOOLS } from './directorTools';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (children: ReactNode) => <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>;

const composition = { id: 'comp123', brief: { summary: 'A running shoe ad' } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  pickState.file = { id: 'file789', fileName: 'shoe.png' };
  featureState.agentMode = true;
  mockGenerateNewSession.mockResolvedValue({ id: 'session1' });
});

const openDialog = () => {
  render(wrap(<DirectButton composition={composition} blocked={false} />));
  fireEvent.click(screen.getByTestId('production-direct-btn'));
};

describe('DirectButton', () => {
  it('launches the director agent with the tools, composition id and product photo', async () => {
    openDialog();
    fireEvent.click(screen.getByTestId('production-direct-product-pick-btn'));
    expect(await screen.findByTestId('production-direct-product-name')).toHaveTextContent('shoe.png');
    fireEvent.click(screen.getByTestId('production-direct-submit-btn'));

    await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
    const dispatch = setProgrammaticLaunch.mock.calls[0][0];
    expect(dispatch.forceAgent).toBe(true);
    expect(dispatch.sessionId).toBe('session1');
    expect(dispatch.requiredTools).toEqual([...DIRECTOR_TOOLS]);
    expect(dispatch.systemContext).toContain('comp123');
    expect(dispatch.promptContent).toContain('Direct this production: A running shoe ad');
    expect(dispatch.promptContent).toContain('file789');
    expect(dispatch.promptContent).toContain('Production id: comp123');
    expect(mockGenerateNewSession).toHaveBeenCalledWith('Direct: A running shoe ad');
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/notebooks/$id', params: { id: 'session1' } });
  });

  it('omits the product line when none is picked and clears a picked one', async () => {
    openDialog();
    fireEvent.click(screen.getByTestId('production-direct-product-pick-btn'));
    fireEvent.click(await screen.findByTestId('production-direct-product-clear-btn'));
    fireEvent.click(screen.getByTestId('production-direct-submit-btn'));

    await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
    expect(setProgrammaticLaunch.mock.calls[0][0].promptContent).not.toContain('Product photo');
  });

  it('requires a brief', () => {
    render(wrap(<DirectButton composition={{ id: 'comp123', brief: {} } as never} blocked={false} />));
    fireEvent.click(screen.getByTestId('production-direct-btn'));
    expect(screen.getByTestId('production-direct-submit-btn')).toBeDisabled();
  });

  it('shows an error and does not launch when the session cannot be created', async () => {
    mockGenerateNewSession.mockRejectedValue(new Error('boom'));
    openDialog();
    fireEvent.click(screen.getByTestId('production-direct-submit-btn'));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('boom'));
    expect(setProgrammaticLaunch).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('is not offered without agent mode, since the launch would run as a plain chat', () => {
    featureState.agentMode = false;
    render(wrap(<DirectButton composition={composition} blocked={false} />));
    expect(screen.queryByTestId('production-direct-btn')).toBeNull();
  });

  it('is disabled while the editor cannot save its draft on the way out', () => {
    render(wrap(<DirectButton composition={composition} blocked />));
    expect(screen.getByTestId('production-direct-btn')).toBeDisabled();
  });
});

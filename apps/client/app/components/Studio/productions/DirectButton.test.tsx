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
import { DIRECTOR_TOOLS, buildDirectorSystemContext, defaultStudioTimeline } from '@bike4mind/common';

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
    expect(dispatch.productionCompositionId).toBe('comp123');
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

  it('names the brand kit product when none is picked, so a re-direct does not ask for one', async () => {
    render(
      wrap(
        <DirectButton
          composition={
            { id: 'comp123', brief: { summary: 'Again' }, brandKit: { productFileIds: ['kit456'] } } as never
          }
          blocked={false}
        />
      )
    );
    fireEvent.click(screen.getByTestId('production-direct-btn'));
    fireEvent.click(screen.getByTestId('production-direct-submit-btn'));

    await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
    expect(setProgrammaticLaunch.mock.calls[0][0].promptContent).toContain(
      'Product photo: already in the brand kit (kit456)'
    );
  });

  const authoredShots = [
    { id: 'shot-1', title: 'Hook', prompt: 'A runner at dawn', voiceLine: 'Start strong.', fileIds: ['take1'] },
    { id: 'shot-2', title: 'Product', prompt: 'The shoe on wet asphalt', fileIds: [] },
  ];
  const starterShots = [
    { id: 'shot-1', title: 'Hook', intent: 'Grab attention', fileIds: [] },
    { id: 'shot-2', title: 'Product', intent: 'Show the product', fileIds: [] },
  ];

  const redirect = (summary: string, typed?: string, shots: readonly object[] = authoredShots) => {
    render(wrap(<DirectButton composition={{ id: 'comp123', brief: { summary }, shots } as never} blocked={false} />));
    fireEvent.click(screen.getByTestId('production-direct-btn'));
    if (typed !== undefined) {
      fireEvent.change(screen.getByTestId('production-direct-brief-input'), { target: { value: typed } });
    }
    fireEvent.click(screen.getByTestId('production-direct-submit-btn'));
  };

  it('says a new brief replaces the current ad when the production already has shots', async () => {
    redirect('A running shoe ad', 'A bright gym ad for a water bottle');

    await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
    expect(setProgrammaticLaunch.mock.calls[0][0].promptContent).toContain(
      'It already has 2 shots from an earlier brief. This brief replaces that ad'
    );
    expect(setProgrammaticLaunch.mock.calls[0][0].promptContent).toContain('applies to this message only');
  });

  it("does not treat a template's starter shots as an earlier ad", async () => {
    redirect('', 'A bright gym ad for a water bottle', starterShots);

    await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
    expect(setProgrammaticLaunch.mock.calls[0][0].promptContent).not.toContain('replaces that ad');
  });

  it('does not ask for a new ad when the brief is the saved one', async () => {
    redirect('A running shoe ad');

    await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
    expect(setProgrammaticLaunch.mock.calls[0][0].promptContent).not.toContain('replaces that ad');
  });

  it('directs a short film with the film context, no product photo and a film redirect', async () => {
    const timeline = defaultStudioTimeline('short_film', { durationMs: 90_000 });
    const film = {
      id: 'comp123',
      template: 'short_film',
      brief: { summary: 'A lighthouse keeper', tone: 'wistful' },
      brandKit: { productFileIds: ['kit456'] },
      shots: authoredShots,
      timeline,
    };
    render(wrap(<DirectButton composition={film as never} blocked={false} />));
    fireEvent.click(screen.getByTestId('production-direct-btn'));
    expect(screen.queryByTestId('production-direct-product-pick-btn')).toBeNull();
    expect(screen.getByTestId('production-direct-brief-input')).toHaveAttribute(
      'placeholder',
      'A lighthouse keeper finds a message in a bottle addressed to her'
    );
    fireEvent.change(screen.getByTestId('production-direct-brief-input'), { target: { value: 'A new story' } });
    fireEvent.click(screen.getByTestId('production-direct-submit-btn'));

    await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
    const dispatch = setProgrammaticLaunch.mock.calls[0][0];
    expect(dispatch.systemContext).toBe(
      buildDirectorSystemContext('comp123', { template: 'short_film', tone: 'wistful', durationMs: 90_000 })
    );
    expect(dispatch.promptContent).not.toContain('Product photo');
    expect(dispatch.promptContent).toContain('This brief replaces that film');
  });

  it('keeps the ad context for an ad production that carries its template and timeline', async () => {
    const ad = {
      id: 'comp123',
      template: 'ad_campaign',
      brief: { summary: 'A running shoe ad' },
      timeline: defaultStudioTimeline('ad_campaign'),
    };
    render(wrap(<DirectButton composition={ad as never} blocked={false} />));
    fireEvent.click(screen.getByTestId('production-direct-btn'));
    fireEvent.click(screen.getByTestId('production-direct-submit-btn'));

    await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
    expect(setProgrammaticLaunch.mock.calls[0][0].systemContext).toBe(buildDirectorSystemContext('comp123'));
  });

  it('counts a single earlier shot and treats a production with no saved brief as re-briefed', async () => {
    render(
      wrap(
        <DirectButton
          composition={
            {
              id: 'comp123',
              brief: {},
              shots: [
                { id: 'shot-1', title: 'Hook', voiceLine: 'Start strong.' },
                { id: 'shot-2', title: 'Bare' },
              ],
            } as never
          }
          blocked={false}
        />
      )
    );
    fireEvent.click(screen.getByTestId('production-direct-btn'));
    fireEvent.change(screen.getByTestId('production-direct-brief-input'), { target: { value: 'A new ad' } });
    fireEvent.click(screen.getByTestId('production-direct-submit-btn'));

    await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
    expect(setProgrammaticLaunch.mock.calls[0][0].promptContent).toContain('It already has 1 shot from an earlier');
  });

  it('still mints a uuid nonce without crypto.randomUUID', async () => {
    const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal('crypto', { getRandomValues: realGetRandomValues });
    try {
      openDialog();
      fireEvent.click(screen.getByTestId('production-direct-submit-btn'));
      await waitFor(() => expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1));
      expect(setProgrammaticLaunch.mock.calls[0][0].dispatchNonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps no product when the picker returns nothing', () => {
    pickState.file = null;
    openDialog();
    fireEvent.click(screen.getByTestId('production-direct-product-pick-btn'));
    expect(screen.queryByTestId('production-direct-product-name')).toBeNull();
  });

  it('closes the dialog on cancel', () => {
    openDialog();
    fireEvent.click(screen.getByTestId('production-direct-cancel-btn'));
    return waitFor(() => expect(screen.queryByTestId('production-direct-dialog')).toBeNull());
  });

  it('shows a generic error when the failure is not an Error', async () => {
    mockGenerateNewSession.mockRejectedValue('nope');
    openDialog();
    fireEvent.click(screen.getByTestId('production-direct-submit-btn'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Could not start directing. Please try again.'));
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

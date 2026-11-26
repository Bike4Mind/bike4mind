import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { TutorialRunModule } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const input = vi.hoisted(() => ({ chatInputValue: '' }));
const enabled = vi.hoisted(() => ({ current: true }));
const modules = vi.hoisted(() => ({ current: [] as TutorialRunModule[] }));
vi.mock('@client/app/hooks/useChatInput', () => ({ useChatInput: { getState: () => input } }));
vi.mock('@client/app/hooks/useStreamingState', () => ({
  useStreamingState: { getState: () => ({ isAnyStreaming: () => false }) },
}));
vi.mock('@client/app/hooks/data/tutorials', () => ({ useTutorialsEnabled: () => enabled.current }));
vi.mock('@client/app/hooks/tutorials/useTutorialRun', () => ({
  useTutorialRunModules: () => ({ data: modules.current }),
}));

import { TutorialOffer } from './TutorialOffer';
import { useTutorialPicker } from './tutorialPickerStore';
import { CALM_RECHECK_MS, CALM_SETTLE_MS } from './useCalmMoment';

const appTheme = extendTheme({ ...getThemeConfig() });
const basics: TutorialRunModule = {
  id: 'first-steps',
  title: 'First steps',
  pitch: '',
  version: 1,
  revision: 0,
  enabled: true,
  steps: [{ id: 'a', type: 'point', body: 'a' }],
  track: 'basics',
};

const renderOffer = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <TutorialOffer />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.useFakeTimers();
  input.chatInputValue = '';
  enabled.current = true;
  modules.current = [basics];
  useTutorialPicker.setState({ open: false, requestedTrack: null, offerWaiting: false, offerAnswered: false });
});
afterEach(() => vi.useRealTimers());

describe('TutorialOffer', () => {
  it('waits for the page to settle before offering anything', () => {
    renderOffer();
    expect(screen.queryByTestId('tutorial-offer')).toBeNull();
    act(() => vi.advanceTimersByTime(CALM_SETTLE_MS));
    expect(screen.getByTestId('tutorial-offer')).toBeInTheDocument();
  });

  it('holds back while the user is typing, and while a modal is open', () => {
    input.chatInputValue = 'hello';
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    renderOffer();
    act(() => vi.advanceTimersByTime(CALM_SETTLE_MS + CALM_RECHECK_MS * 2));
    expect(screen.queryByTestId('tutorial-offer')).toBeNull();
    input.chatInputValue = '';
    act(() => vi.advanceTimersByTime(CALM_RECHECK_MS * 2));
    // Still held by the open modal.
    expect(screen.queryByTestId('tutorial-offer')).toBeNull();
    dialog.remove();
    act(() => vi.advanceTimersByTime(CALM_RECHECK_MS));
    expect(screen.getByTestId('tutorial-offer')).toBeInTheDocument();
  });

  it('offers only the tracks that have tutorials, and starts nothing on its own', () => {
    renderOffer();
    act(() => vi.advanceTimersByTime(CALM_SETTLE_MS));
    expect(screen.getByTestId('tutorial-offer-basics')).toBeInTheDocument();
    expect(screen.queryByTestId('tutorial-offer-different')).toBeNull();
    expect(useTutorialPicker.getState().requestedTrack).toBeNull();
    fireEvent.click(screen.getByTestId('tutorial-offer-basics'));
    expect(useTutorialPicker.getState().requestedTrack).toBe('basics');
  });

  it('opens the picker from See all tutorials', () => {
    renderOffer();
    act(() => vi.advanceTimersByTime(CALM_SETTLE_MS));
    fireEvent.click(screen.getByTestId('tutorial-offer-all'));
    expect(useTutorialPicker.getState().open).toBe(true);
  });

  it('shows nothing while core tutorials are switched off', () => {
    enabled.current = false;
    renderOffer();
    act(() => vi.advanceTimersByTime(CALM_SETTLE_MS * 2));
    expect(screen.queryByTestId('tutorial-offer')).toBeNull();
  });
  it('marks the offer as waiting while it is enabled with modules', () => {
    renderOffer();
    expect(useTutorialPicker.getState().offerWaiting).toBe(true);
  });

  it('answers the offer when a track is taken up', () => {
    renderOffer();
    act(() => vi.advanceTimersByTime(CALM_SETTLE_MS));
    fireEvent.click(screen.getByTestId('tutorial-offer-basics'));
    expect(useTutorialPicker.getState().offerAnswered).toBe(true);
    expect(useTutorialPicker.getState().offerWaiting).toBe(false);
  });

  it('answers the offer when See all tutorials is clicked', () => {
    renderOffer();
    act(() => vi.advanceTimersByTime(CALM_SETTLE_MS));
    fireEvent.click(screen.getByTestId('tutorial-offer-all'));
    expect(useTutorialPicker.getState().offerAnswered).toBe(true);
    expect(useTutorialPicker.getState().offerWaiting).toBe(false);
  });

  it('stops waiting when it unmounts', () => {
    const { unmount } = renderOffer();
    expect(useTutorialPicker.getState().offerWaiting).toBe(true);
    unmount();
    expect(useTutorialPicker.getState().offerWaiting).toBe(false);
  });

  it('does not wait while core tutorials are switched off', () => {
    enabled.current = false;
    renderOffer();
    expect(useTutorialPicker.getState().offerWaiting).toBe(false);
  });
});

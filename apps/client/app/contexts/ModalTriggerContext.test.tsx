// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markFirstSignupSession } from '@client/app/utils/firstSignupSession';
import { releaseNoteToModal } from '../components/modals/releaseNoteSlides';
import {
  resetWhatsNewShownForTests,
  wasWhatsNewShown,
  markGearsDiscoveryShown,
} from '../components/modals/whatsNewSession';
import { ModalTriggerProvider, SETTLE_DELAY, useModalTrigger } from './ModalTriggerContext';

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  createdAt: new Date('2020-01-01'),
  counters: { isPending: false, data: [] as unknown[] },
}));

vi.mock('../components/modals/WhatsNewSliderModal', () => ({
  default: (props: { autoTriggered?: boolean }) => (
    <div data-testid="whats-new-slider" data-auto={String(props.autoTriggered)} />
  ),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: unknown }) => unknown) =>
    selector({ currentUser: { id: 'user-1', createdAt: mocks.createdAt } }),
}));
vi.mock('@client/app/hooks/data/modalsWithReleaseNotes', () => ({
  useModalsWithReleaseNotes: () => ({ data: [], refetch: mocks.refetch }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUserActivityCounters: () => mocks.counters,
}));
vi.mock('@client/app/hooks/useStreamingState', () => ({
  useStreamingState: { getState: () => ({ isAnyStreaming: () => false }) },
}));
vi.mock('@client/app/utils/anyDialogOpen', () => ({ isAnyModalDialogOpen: () => false }));

const Consumer = () => {
  const { triggerModalByTag } = useModalTrigger();
  return (
    <>
      <button data-testid="trigger-auto-btn" onClick={() => triggerModalByTag('whats-new', 'WhatsNewSlider', 'auto')} />
      <button
        data-testid="trigger-manual-btn"
        onClick={() => triggerModalByTag('whats-new', 'WhatsNewSlider', 'manual')}
      />
      <button data-testid="trigger-default-btn" onClick={() => triggerModalByTag('whats-new', 'WhatsNewSlider')} />
    </>
  );
};

const renderProvider = () =>
  render(
    <ModalTriggerProvider>
      <Consumer />
    </ModalTriggerProvider>
  );

const sliderAuto = () => screen.getByTestId('whats-new-slider').getAttribute('data-auto');

describe('ModalTriggerContext whats-new trigger source', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWhatsNewShownForTests();
    mocks.createdAt = new Date('2020-01-01');
    mocks.refetch.mockReset();
    mocks.counters = { isPending: false, data: [] };
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore the document.hidden spy so a later test does not inherit the stub.
    vi.restoreAllMocks();
  });

  it("marks What's New as shown only when the slider is triggered", () => {
    renderProvider();
    expect(wasWhatsNewShown()).toBe(false);
    fireEvent.click(screen.getByTestId('trigger-auto-btn'));
    expect(wasWhatsNewShown()).toBe(true);
  });

  it('skips the tab-return auto-trigger once the gears discovery modal has opened', async () => {
    vi.useFakeTimers();
    markGearsDiscoveryShown();
    mocks.refetch.mockResolvedValue({
      data: [
        releaseNoteToModal({
          id: 'n1',
          release_tag: 'v1.0.0',
          headline: 'Headline',
          summary: 'Summary',
          published_at: new Date('2026-01-01').toISOString(),
          items: [],
        } as never),
      ],
    });
    localStorage.setItem('tab_last_hidden_at', String(Date.now() - 6 * 60 * 1000));
    renderProvider();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);
    });
    expect(mocks.refetch).toHaveBeenCalled();
    expect(screen.queryByTestId('whats-new-slider')).not.toBeInTheDocument();
  });

  it('renders the slider as auto-triggered for an auto call', () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('trigger-auto-btn'));
    expect(sliderAuto()).toBe('true');
  });

  it('renders the slider as not auto-triggered when the source is omitted', () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('trigger-default-btn'));
    expect(sliderAuto()).toBe('false');
  });

  it('flips back to not auto-triggered when a manual call follows an auto call', () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('trigger-auto-btn'));
    expect(sliderAuto()).toBe('true');
    fireEvent.click(screen.getByTestId('trigger-manual-btn'));
    expect(sliderAuto()).toBe('false');
  });

  it('suppresses visibility auto-triggers throughout a first signup session', async () => {
    vi.useFakeTimers();
    markFirstSignupSession('user-1');
    renderProvider();
    localStorage.setItem('tab_last_hidden_at', String(Date.now()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    });
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);
    });
    expect(mocks.refetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('whats-new-slider')).not.toBeInTheDocument();
  });

  it('still opens the slider for a manual trigger during a first signup session', () => {
    markFirstSignupSession('user-1');
    renderProvider();
    fireEvent.click(screen.getByTestId('trigger-manual-btn'));
    expect(screen.getByTestId('whats-new-slider')).toBeInTheDocument();
    expect(sliderAuto()).toBe('false');
  });

  it('auto-triggers the slider when the tab returns after 5+ minutes with an unseen slide', async () => {
    // Pin the user-facing settle delay; the advances below only exercise its boundary.
    expect(SETTLE_DELAY).toBe(2500);
    vi.useFakeTimers();
    const note = releaseNoteToModal({
      id: 'n1',
      release_tag: 'v1.0.0',
      headline: 'Headline',
      summary: 'Summary',
      published_at: new Date('2026-01-01').toISOString(),
      items: [],
    } as never);
    mocks.refetch.mockResolvedValue({ data: [note] });
    localStorage.setItem('tab_last_hidden_at', String(Date.now() - 6 * 60 * 1000));
    renderProvider();

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));

    // Nothing fires until the settle delay has fully elapsed...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY - 1);
    });
    expect(mocks.refetch).not.toHaveBeenCalled();

    // ...and it fires once it has.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.refetch).toHaveBeenCalled();
    expect(sliderAuto()).toBe('true');
  });
});

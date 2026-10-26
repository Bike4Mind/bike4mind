// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModalManager from './ModalManager';
import { releaseNoteToModal } from './releaseNoteSlides';
import { markGearsDiscoveryShown, resetWhatsNewShownForTests } from './whatsNewSession';
import {
  markFirstSignupSession,
  FIRST_SIGNUP_SESSION_KEY,
  FIRST_SIGNUP_SESSION_TTL_MS,
} from '@client/app/utils/firstSignupSession';
import type { IModal } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  triggerModalByTag: vi.fn(),
  modals: { data: [] as IModal[], isPending: false, slidesPending: false },
  createdAt: new Date('2020-01-01'),
}));

vi.mock('./GenericModal', () => ({
  default: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="generic-modal" /> : null),
}));
vi.mock('./BannerModal', () => ({ default: () => <div data-testid="banner-modal" /> }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: unknown }) => unknown) =>
    selector({ currentUser: { id: 'user-1', createdAt: mocks.createdAt } }),
}));
vi.mock('@client/app/contexts/ModalTriggerContext', () => ({
  useModalTrigger: () => ({
    resetTrigger: vi.fn(),
    triggerModalByTag: mocks.triggerModalByTag,
    tagToTrigger: null,
    triggerCounter: 0,
  }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUserActivityCounters: () => ({ isPending: false, data: [] }),
}));
vi.mock('@client/app/hooks/data/modalsWithReleaseNotes', () => ({
  useModalsWithReleaseNotes: () => mocks.modals,
}));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: vi.fn() }) }));
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useGetPresignedUrl: () => ({ mutate: vi.fn() }) }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ state: { location: { pathname: '/' } } }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@client/app/hooks/useStreamingState', () => ({
  useStreamingState: (selector: (s: { isAnyStreaming: () => boolean }) => unknown) =>
    selector({ isAnyStreaming: () => false }),
}));
vi.mock('@client/app/utils/anyDialogOpen', () => ({ isAnyModalDialogOpen: () => false }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ModalManager whats-new auto-trigger', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWhatsNewShownForTests();
    mocks.triggerModalByTag.mockReset();
    mocks.createdAt = new Date('2020-01-01');
    mocks.modals.slidesPending = false;
    mocks.modals.data = [
      releaseNoteToModal({
        id: 'n1',
        release_tag: 'v1.0.0',
        headline: 'Headline',
        summary: 'Summary',
        published_at: new Date('2026-01-01').toISOString(),
        items: [],
      } as never),
    ];
  });

  it('opens the slider with the auto source for an unseen release-note slide', () => {
    render(<ModalManager />);
    expect(mocks.triggerModalByTag).toHaveBeenCalledWith('whats-new', 'WhatsNewSlider', 'auto');
  });

  it('waits for the release-note feed before auto-triggering, then triggers once', () => {
    mocks.modals.slidesPending = true;
    // ModalManager is memoized and the mocked hooks cannot schedule a render, so a changing prop forces one
    const Manager = ModalManager as React.ComponentType<{ tick?: number }>;
    const { rerender } = render(<Manager tick={0} />);
    expect(mocks.triggerModalByTag).not.toHaveBeenCalled();

    mocks.modals.slidesPending = false;
    rerender(<Manager tick={1} />);
    expect(mocks.triggerModalByTag).toHaveBeenCalledTimes(1);
  });

  it('does not auto-trigger once the gears discovery modal has opened in this page load', () => {
    markGearsDiscoveryShown();
    render(<ModalManager />);
    expect(mocks.triggerModalByTag).not.toHaveBeenCalled();
  });

  it('does not auto-trigger during a first signup session', () => {
    markFirstSignupSession('user-1');
    render(<ModalManager />);
    expect(mocks.triggerModalByTag).not.toHaveBeenCalled();
  });
});

const announcement = (isBanner = false): IModal => ({
  _id: isBanner ? 'announcement-banner' : 'announcement',
  title: 'Announcement',
  subtitle: null,
  description: null,
  tags: null,
  closeButton: true,
  agreeButton: false,
  startDate: null,
  endDate: null,
  numberOfAgrees: null,
  imageUrl: null,
  textMessage: null,
  priority: 1,
  enabled: true,
  isBanner,
  numberOfViews: { type: 'firstTime', threshold: 1, value: 0 },
});

describe('ModalManager new-account suppression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T04:00:00Z'));
    resetWhatsNewShownForTests();
    mocks.modals.data = [announcement(), announcement(true)];
    mocks.modals.isPending = false;
    mocks.modals.slidesPending = false;
    localStorage.clear();
    mocks.triggerModalByTag.mockReset();
    markFirstSignupSession('user-1');
  });

  it('suppresses announcements and banners throughout a new account first visit', () => {
    const Manager = ModalManager as React.ComponentType<{ tick?: number }>;
    const { rerender } = render(<Manager tick={0} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByTestId('generic-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('banner-modal')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(11 * 60 * 1000));
    rerender(<Manager tick={1} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByTestId('generic-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('banner-modal')).not.toBeInTheDocument();
  });

  it('keeps suppressing after a reload beyond the grace window', () => {
    const firstVisit = render(<ModalManager />);
    firstVisit.unmount();
    act(() => vi.advanceTimersByTime(11 * 60 * 1000));
    render(<ModalManager />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByTestId('generic-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('banner-modal')).not.toBeInTheDocument();
  });

  it('honours the marker just before the TTL and ignores it after', () => {
    act(() => vi.advanceTimersByTime(FIRST_SIGNUP_SESSION_TTL_MS - 1000));
    const early = render(<ModalManager />);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByTestId('generic-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('banner-modal')).not.toBeInTheDocument();
    early.unmount();

    act(() => vi.advanceTimersByTime(1000));
    render(<ModalManager />);
    expect(screen.getByTestId('banner-modal')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByTestId('generic-modal')).toBeInTheDocument();
  });

  it('shows the same announcements on a later visit', () => {
    const firstVisit = render(<ModalManager />);
    firstVisit.unmount();
    localStorage.removeItem(FIRST_SIGNUP_SESSION_KEY);

    render(<ModalManager />);
    expect(screen.getByTestId('banner-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('generic-modal')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByTestId('generic-modal')).toBeInTheDocument();
  });
});

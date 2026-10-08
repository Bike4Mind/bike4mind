// @vitest-environment jsdom
import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ModalManager from './ModalManager';
import { releaseNoteToModal } from './releaseNoteSlides';

const mocks = vi.hoisted(() => ({
  triggerModalByTag: vi.fn(),
  modals: { data: [] as unknown[], isPending: false },
  createdAt: new Date('2020-01-01'),
}));

vi.mock('./GenericModal', () => ({ default: () => <div data-testid="generic-modal" /> }));
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

describe('ModalManager whats-new auto-trigger', () => {
  beforeEach(() => {
    mocks.triggerModalByTag.mockReset();
    mocks.createdAt = new Date('2020-01-01');
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

  it('does not auto-trigger for a brand-new account', () => {
    mocks.createdAt = new Date();
    render(<ModalManager />);
    expect(mocks.triggerModalByTag).not.toHaveBeenCalled();
  });
});

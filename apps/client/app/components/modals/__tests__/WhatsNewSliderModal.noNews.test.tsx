// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IModalDocument, PublicReleaseNote } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { releaseNoteToModal } from '../releaseNoteSlides';
import WhatsNewSliderModal from '../WhatsNewSliderModal';

const mocks = vi.hoisted(() => ({
  user: { id: 'u1', tags: [] },
  counters: { isPending: false, data: [] as unknown[] },
  modals: { data: undefined as unknown, isPending: false, slidesPending: false, refetch: vi.fn() },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mocks.user }),
}));
vi.mock('@client/app/hooks/data/modalsWithReleaseNotes', () => ({
  useModalsWithReleaseNotes: () => mocks.modals,
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUserActivityCounters: () => mocks.counters,
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: vi.fn() }) }));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetPresignedUrl: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/contexts/ModalTriggerContext', () => ({
  useModalTrigger: () => ({ resetTrigger: vi.fn() }),
}));
vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const ui = () => (
  <CssVarsProvider theme={appTheme}>
    <WhatsNewSliderModal tagToTrigger="whats-new" />
  </CssVarsProvider>
);

const slide: IModalDocument = releaseNoteToModal({
  id: 'rn1',
  release_tag: 'v1.2.3',
  headline: 'Faster search',
  summary: 'Search is quicker now.',
  published_at: '2026-03-05T15:00:00.000Z',
  items: [],
} as PublicReleaseNote);

describe('WhatsNewSliderModal no-news state', () => {
  beforeEach(() => {
    mocks.modals = { data: [], isPending: false, slidesPending: true, refetch: vi.fn() };
  });

  it('does not stick on no-news when release-note slides arrive after the modals', () => {
    const { rerender } = render(ui());
    expect(screen.queryByTestId('no-news-ok-btn')).toBeNull();

    mocks.modals = { data: [slide], isPending: false, slidesPending: false, refetch: vi.fn() };
    rerender(ui());

    expect(screen.getAllByText('Faster search').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('no-news-ok-btn')).toBeNull();
  });

  it('shows no-news once slides have settled with nothing to show', () => {
    mocks.modals = { data: [], isPending: false, slidesPending: false, refetch: vi.fn() };
    render(ui());
    expect(screen.getByTestId('no-news-ok-btn')).toBeTruthy();
  });
});

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import type { ManagedArtifact } from '@client/app/utils/publishApi';
import { PublishedArtifactCard, type PublishedArtifactCardProps } from './PublishedArtifactCard';

const appTheme = extendTheme({ ...getThemeConfig() });

const artifact: ManagedArtifact = {
  publicId: 'pub-1',
  tier: 'user',
  scopeId: 'erik',
  slug: 'quarterly-planning',
  title: 'Quarterly planning notes',
  visibility: 'public',
  commentPolicy: 'none',
  source: { kind: 'bundle' },
  versionsCount: 3,
  viewCount: 128,
  publishedAt: '2026-03-04T10:00:00.000Z',
};

const URL = 'https://app.example/p/u/erik/quarterly-planning';

const renderCard = (over: Partial<PublishedArtifactCardProps> = {}, art: Partial<ManagedArtifact> = {}) => {
  const onCopyLink = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <CssVarsProvider theme={appTheme}>
      <ul>
        <PublishedArtifactCard
          artifact={{ ...artifact, ...art }}
          url={URL}
          onCopyLink={onCopyLink}
          onOpenSettings={onOpenSettings}
          {...over}
        />
      </ul>
    </CssVarsProvider>
  );
  return { onCopyLink, onOpenSettings };
};

describe('PublishedArtifactCard', () => {
  it('renders the card with the row test-id scheme, prefixed with card-', () => {
    renderCard();
    for (const part of ['', 'cover-', 'access-', 'title-', 'date-', 'versions-', 'views-', 'copy-', 'more-']) {
      expect(screen.getByTestId(`published-artifact-card-${part}pub-1`), part).toBeTruthy();
    }
  });

  it('shows the access badge with its icon and word, not color alone', () => {
    renderCard({}, { visibility: 'public', gateKind: 'passphrase' });
    const badge = screen.getByTestId('published-artifact-card-access-pub-1');
    expect(badge.textContent).toBe('Passphrase');
    expect(badge.getAttribute('data-access')).toBe('passphrase');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('keeps the visibility word on a private card and adds the gate icon after it', () => {
    renderCard({}, { visibility: 'private', gateKind: 'passphrase' });
    const badge = screen.getByTestId('published-artifact-card-access-pub-1');
    expect(badge.textContent).toBe('Private');
    expect(badge.getAttribute('data-access')).toBe('private');
    expect(badge.getAttribute('data-link-gate')).toBe('passphrase');
    // Visibility icon first, gate icon after the word.
    expect(badge.querySelectorAll('svg')).toHaveLength(2);
  });

  it('makes the title the only link, opening the share URL in a new tab', () => {
    renderCard();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(screen.getByTestId('published-artifact-card-title-pub-1'));
    expect(links[0].getAttribute('href')).toBe(URL);
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toContain('noopener');
    // The tooltip must not replace the title as the link's name.
    expect(screen.getByRole('link', { name: 'Quarterly planning notes' })).toBe(links[0]);
  });

  it('shows date, versions and views on the meta line', () => {
    renderCard();
    expect(screen.getByTestId('published-artifact-card-versions-pub-1').textContent).toBe('3 versions');
    expect(screen.getByTestId('published-artifact-card-views-pub-1').textContent).toContain('128');
    expect(screen.getByTestId('published-artifact-card-date-pub-1').textContent).toMatch(/\d/);
  });

  it('uses tabular figures for the counts so digits do not jitter between cards', () => {
    renderCard();
    const meta = screen.getByTestId('published-artifact-card-views-pub-1').parentElement as HTMLElement;
    expect(getComputedStyle(meta).fontVariantNumeric).toBe('tabular-nums');
  });

  it('says "1 version" for a single-version bundle and omits versions for other kinds', () => {
    const { unmount } = render(
      <CssVarsProvider theme={appTheme}>
        <ul>
          <PublishedArtifactCard
            artifact={{ ...artifact, versionsCount: 1 }}
            url={URL}
            onCopyLink={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        </ul>
      </CssVarsProvider>
    );
    expect(screen.getByTestId('published-artifact-card-versions-pub-1').textContent).toBe('1 version');
    unmount();

    renderCard({}, { source: { kind: 'reply' } });
    expect(screen.queryByTestId('published-artifact-card-versions-pub-1')).toBeNull();
  });

  it('compacts large view counts and keeps the exact number as the title', () => {
    renderCard({}, { viewCount: 12_345 });
    const views = screen.getByTestId('published-artifact-card-views-pub-1');
    expect(views.getAttribute('title')).toBe('12345 views');
    expect(views.textContent).not.toContain('12345');
  });

  it('gives the buttons accessible names that say which artifact they act on', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'Copy link to Quarterly planning notes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings for Quarterly planning notes' })).toBeTruthy();
  });

  it('calls the copy and settings handlers', () => {
    const { onCopyLink, onOpenSettings } = renderCard();
    fireEvent.click(screen.getByTestId('published-artifact-card-copy-pub-1'));
    expect(onCopyLink).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('does not open anything when the card body is clicked: only the buttons act', () => {
    const { onCopyLink, onOpenSettings } = renderCard();
    fireEvent.click(screen.getByTestId('published-artifact-card-pub-1'));
    expect(onCopyLink).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('shows the generated cover letter when there is no thumbnail', () => {
    renderCard();
    const cover = screen.getByTestId('published-artifact-card-cover-pub-1');
    expect(cover.textContent).toBe('Q');
    expect(within(cover).queryByRole('img')).toBeNull();
  });

  it('renders the thumbnail image when thumbnailUrl is present', () => {
    renderCard({}, { thumbnailUrl: 'https://cdn.example/thumbs/pub-1.png' });
    const img = screen.getByTestId('published-artifact-card-cover-pub-1-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://cdn.example/thumbs/pub-1.png');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('alt')).toBe('');
  });

  it('falls back to the cover when the thumbnail fails to load', () => {
    renderCard({}, { thumbnailUrl: 'https://cdn.example/thumbs/missing.png' });
    fireEvent.error(screen.getByTestId('published-artifact-card-cover-pub-1-image'));
    expect(screen.queryByTestId('published-artifact-card-cover-pub-1-image')).toBeNull();
    expect(screen.getByTestId('published-artifact-card-cover-pub-1').textContent).toBe('Q');
  });
});

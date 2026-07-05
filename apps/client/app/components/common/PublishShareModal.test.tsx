import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { PublishShareModal } from './PublishShareModal';
import type { PublishResult } from '@bike4mind/common';

// Mock the axios instance so we can assert the exact comment-policy PATCH an update issues
// (the restricted->open widening regression). Mocking at the transport level keeps the real
// publishApi helpers, whose URL/body shape is what we're verifying.
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn().mockResolvedValue({ data: {} }) },
}));
import { api } from '@client/app/contexts/ApiContext';
const apiPatch = api.patch as unknown as ReturnType<typeof vi.fn>;

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const noopPublish = vi.fn<[], Promise<PublishResult>>();

/** Read the checked radio input by its `value` attribute (visibility radios carry no label).
 *  Queries `document` because MUI `Modal` renders its content into a body portal, not `container`. */
const radio = (value: string) =>
  document.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement | null;

describe('PublishShareModal — update seeds controls from the prior publication', () => {
  it('carries a PRIVATE, comments-off publication into update mode (does not reset to public)', async () => {
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={noopPublish}
          title="My artifact"
          // defaultVisibility intentionally 'public' - the found publication must override it.
          defaultVisibility="public"
          resolveExisting={() =>
            Promise.resolve({
              title: 'My artifact',
              versionsCount: 1,
              slug: 's',
              visibility: 'private',
              commentPolicy: 'none',
            })
          }
        />
      </Wrapper>
    );

    // Wait for the async lookup to resolve and reveal the update/new choice.
    await screen.findByTestId('publish-share-mode-update');

    expect(radio('update')?.checked).toBe(true);
    // The regression: without seeding, this would be 'public' + comments on.
    expect(radio('private')?.checked).toBe(true);
    expect(radio('public')?.checked).toBe(false);
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
  });

  it('carries a PUBLIC, comments-open publication through unchanged', async () => {
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={noopPublish}
          title="My artifact"
          defaultVisibility="private"
          resolveExisting={() =>
            Promise.resolve({
              title: 'My artifact',
              versionsCount: 2,
              slug: 's',
              visibility: 'public',
              commentPolicy: 'open',
            })
          }
        />
      </Wrapper>
    );

    await screen.findByTestId('publish-share-mode-update');

    expect(radio('public')?.checked).toBe(true);
    expect(radio('private')?.checked).toBe(false);
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);
  });
});

describe('PublishShareModal — update re-asserts the PRESERVED comment policy', () => {
  const publishResult: PublishResult = {
    publicId: 'pub-1',
    url: '/p/u/u1/s',
    tier: 'user',
    scopeId: 'u1',
    slug: 's',
    visibility: 'public',
    publishedAt: '2026-01-01T00:00:00.000Z',
  };

  const renderWithPrior = (commentPolicy: 'open' | 'restricted' | 'none') => {
    apiPatch.mockClear();
    const publish = vi.fn().mockResolvedValue(publishResult);
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={publish}
          title="My artifact"
          defaultVisibility="public"
          resolveExisting={() =>
            Promise.resolve({ title: 'My artifact', versionsCount: 2, slug: 's', visibility: 'public', commentPolicy })
          }
        />
      </Wrapper>
    );
    return { publish };
  };

  it('keeps a RESTRICTED policy restricted (never silently widens it to open)', async () => {
    renderWithPrior('restricted');

    await screen.findByTestId('publish-share-mode-update');
    // Seeded on because 'restricted' still allows comments.
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByTestId('publish-share-create'));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    // The regression: the old blanket 'open' would widen the owner's restricted policy.
    expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { commentPolicy: 'restricted' });
  });

  it('re-asserts open for a comments-open prior', async () => {
    renderWithPrior('open');

    await screen.findByTestId('publish-share-mode-update');
    fireEvent.click(screen.getByTestId('publish-share-create'));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { commentPolicy: 'open' });
  });

  it('does not enable comments when the prior publication had them off', async () => {
    renderWithPrior('none');

    await screen.findByTestId('publish-share-mode-update');
    // Seeded off because the prior policy was 'none'.
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId('publish-share-create'));

    // No comment-policy PATCH fires - the record keeps the server default 'none'.
    await screen.findByTestId('publish-share-url');
    expect(apiPatch).not.toHaveBeenCalled();
  });
});

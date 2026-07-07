import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Regression guard for #147: the gallery renders from the list feed (/api/artifacts),
 * which omits `content`. The card's Share action must hydrate the single artifact's
 * content (via the :id GET, whose string lives at response.content.content) BEFORE
 * wiring the publish dialog - otherwise publishArtifactBundle throws "no content to
 * publish" before any network call and Share silently no-ops.
 *
 * These tests lock three behaviors: (1) a content-less list artifact gets hydrated and
 * the wiring receives the real content, (2) a successful fetch that returns empty
 * content shows the "no content" toast and never opens the dialog, and (3) a failed
 * fetch is reported as a load error - distinct from "no content" - and never opens the
 * dialog.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  publishAndShare: vi.fn(),
  buildArtifactPublishWiring: vi.fn(() => ({ resolveExisting: vi.fn(), publish: vi.fn() })),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.apiGet, post: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
// Zustand selector hooks: call the selector with a minimal state slice.
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: any) => any) => selector({ currentUser: { id: 'u1' } }),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: any) => any) => selector({ selectedAccount: null }),
}));
vi.mock('@client/app/hooks/usePublishShare', () => ({
  usePublishShare: () => ({ publishAndShare: mocks.publishAndShare, modal: null }),
}));
// Mock the wiring builder so we can assert the exact `content` handed to it (the real
// builder returns closures that capture content, which are otherwise opaque here).
vi.mock('@client/app/utils/publishApi', () => ({
  buildArtifactPublishWiring: mocks.buildArtifactPublishWiring,
}));

import { ArtifactGallery } from './ArtifactGallery';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const ARTIFACT_ID = 'artifact_html_demo_123';

const TYPES_RESPONSE = {
  types: [{ type: 'html', name: 'HTML', description: 'HTML page', category: 'web' }],
  categories: ['web'],
};

// The list feed intentionally omits `content` - this is the exact shape the bug hit.
const LIST_RESPONSE = {
  artifacts: [
    {
      id: ARTIFACT_ID,
      type: 'html',
      title: 'My Demo Artifact',
      status: 'draft',
      contentSize: 2048,
      contentHash: 'hash',
      createdAt: new Date('2026-01-01').toISOString(),
      updatedAt: new Date('2026-01-01').toISOString(),
    },
  ],
  pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
};

/** Route api.get by URL; the single-artifact GET is supplied per-test. */
function wireApi(singleArtifact: () => Promise<any>) {
  mocks.apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/api/artifacts/types')) return Promise.resolve({ data: TYPES_RESPONSE });
    if (url.includes('includeContent=true')) return singleArtifact();
    // Base list feed (starts with /api/artifacts but not a sub-resource we handle above).
    if (url.startsWith('/api/artifacts')) return Promise.resolve({ data: LIST_RESPONSE });
    return Promise.resolve({ data: {} });
  });
}

/** Open the card's kebab menu and click Share. */
async function openShare(user: ReturnType<typeof userEvent.setup>) {
  // Wait for the list to render the card past the artifactTypes loading gate.
  await screen.findByText('My Demo Artifact');
  const kebab = await screen.findByTestId('artifact-card-menu-btn');
  await user.click(kebab);
  const share = await screen.findByTestId('artifact-publish-share');
  await user.click(share);
}

describe('ArtifactGallery - Share hydrates content (#147)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates content from the single-artifact GET and passes it to the publish wiring', async () => {
    wireApi(() => Promise.resolve({ data: { content: { content: '<h1>hydrated</h1>' } } }));
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <ArtifactGallery />
      </TestWrapper>
    );

    await openShare(user);

    await waitFor(() => {
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `/api/artifacts/${encodeURIComponent(ARTIFACT_ID)}?includeContent=true`
      );
    });
    await waitFor(() => {
      expect(mocks.buildArtifactPublishWiring).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: ARTIFACT_ID, content: '<h1>hydrated</h1>' })
      );
    });
    expect(mocks.publishAndShare).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('shows a "no content" toast and does not publish when the fetch returns empty content', async () => {
    wireApi(() => Promise.resolve({ data: { content: { content: '' } } }));
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <ArtifactGallery />
      </TestWrapper>
    );

    await openShare(user);

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('This artifact has no content to publish');
    });
    expect(mocks.buildArtifactPublishWiring).not.toHaveBeenCalled();
    expect(mocks.publishAndShare).not.toHaveBeenCalled();
  });

  it('reports a load error (distinct from "no content") and does not publish when the fetch fails', async () => {
    wireApi(() => Promise.reject(new Error('boom')));
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <ArtifactGallery />
      </TestWrapper>
    );

    await openShare(user);

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('Could not load artifact content, please try again');
    });
    expect(mocks.toastError).not.toHaveBeenCalledWith('This artifact has no content to publish');
    expect(mocks.buildArtifactPublishWiring).not.toHaveBeenCalled();
    expect(mocks.publishAndShare).not.toHaveBeenCalled();
  });

  it('ignores a re-entrant Share click while a hydration fetch is already in flight', async () => {
    // A deferred single-artifact fetch we control: keep it pending so the first Share click
    // stays mid-hydration while we fire a second one. The in-flight guard must drop the second.
    let resolveFetch!: (v: any) => void;
    const pending = new Promise<any>(res => {
      resolveFetch = res;
    });
    wireApi(() => pending);
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <ArtifactGallery />
      </TestWrapper>
    );

    await openShare(user); // first click: hydration fetch starts and stays pending
    await openShare(user); // second click while in flight: should be ignored by the guard

    const hydrationCalls = mocks.apiGet.mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('includeContent=true')
    );
    expect(hydrationCalls).toHaveLength(1);

    // Let the first flow finish so it publishes exactly once and no pending work leaks.
    resolveFetch({ data: { content: { content: '<h1>hydrated</h1>' } } });
    await waitFor(() => expect(mocks.publishAndShare).toHaveBeenCalledTimes(1));
  });
});

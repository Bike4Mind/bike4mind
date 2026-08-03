import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * The gallery renders from the list feed (/api/artifacts), which omits `content`. Both the Share
 * and Edit card actions therefore have to hydrate the single artifact first - Share because
 * publishArtifactBundle throws on empty content before any network call, Edit because the editor
 * gates Save on a non-empty content. These tests lock the hydration outcomes for both.
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

/** Route api.get by URL; the single-artifact GET and the list payload are supplied per-test. */
function wireApi(singleArtifact: () => Promise<any>, list: unknown = LIST_RESPONSE) {
  mocks.apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/api/artifacts/types')) return Promise.resolve({ data: TYPES_RESPONSE });
    if (url.includes('includeContent=true')) return singleArtifact();
    // Base list feed (starts with /api/artifacts but not a sub-resource we handle above).
    if (url.startsWith('/api/artifacts')) return Promise.resolve({ data: list });
    return Promise.resolve({ data: {} });
  });
}

/** Open the card's kebab menu and click one of its actions. */
async function openCardAction(user: ReturnType<typeof userEvent.setup>, testId: string) {
  // Wait for the list to render the card past the artifactTypes loading gate.
  await screen.findByText('My Demo Artifact');
  await user.click(await screen.findByTestId('artifact-card-menu-btn'));
  await user.click(await screen.findByTestId(testId));
}
const openShare = (user: ReturnType<typeof userEvent.setup>) => openCardAction(user, 'artifact-publish-share');
const openEdit = (user: ReturnType<typeof userEvent.setup>) => openCardAction(user, 'artifact-edit');

describe('ArtifactGallery - Share hydrates content', () => {
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

describe('ArtifactGallery - Edit hydrates content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates content and hands the artifact to onArtifactEdit with it', async () => {
    wireApi(() => Promise.resolve({ data: { content: { content: '<h1>hydrated</h1>' } } }));
    const onArtifactEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <ArtifactGallery onArtifactEdit={onArtifactEdit} />
      </TestWrapper>
    );

    await openEdit(user);

    await waitFor(() =>
      expect(onArtifactEdit).toHaveBeenCalledWith(
        expect.objectContaining({ id: ARTIFACT_ID, content: '<h1>hydrated</h1>' })
      )
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('refuses to open the editor when the artifact has no content', async () => {
    wireApi(() => Promise.resolve({ data: { content: { content: '' } } }));
    const onArtifactEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <ArtifactGallery onArtifactEdit={onArtifactEdit} />
      </TestWrapper>
    );

    await openEdit(user);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('This artifact has no content to edit'), {
      timeout: 5000,
    });
    expect(onArtifactEdit).not.toHaveBeenCalled();
  });

  it('reports a load error (distinct from "no content") and does not open the editor', async () => {
    wireApi(() => Promise.reject(new Error('boom')));
    const onArtifactEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <ArtifactGallery onArtifactEdit={onArtifactEdit} />
      </TestWrapper>
    );

    await openEdit(user);

    await waitFor(
      () => expect(mocks.toastError).toHaveBeenCalledWith('Could not load artifact content, please try again'),
      { timeout: 5000 }
    );
    expect(mocks.toastError).not.toHaveBeenCalledWith('This artifact has no content to edit');
    expect(onArtifactEdit).not.toHaveBeenCalled();
  });

  // This branch was silently regressed once by moving the id check behind a content short-circuit,
  // and no test caught it - hence pinning it here. The helper is shared, so this covers the
  // publish path's use of the same guard.
  it('refuses an artifact with no stable id before attempting any hydration', async () => {
    // Carries content as well as an empty id: that combination is what slips past a guard placed
    // after the content short-circuit, so this pins the guard's order, not just its existence.
    const idless = { ...LIST_RESPONSE.artifacts[0], id: '', content: '<h1>already here</h1>' };
    // A hydration attempt rejects rather than falling through, so the no-fetch claim cannot pass
    // for the wrong reason.
    wireApi(() => Promise.reject(new Error('should not hydrate an id-less artifact')), {
      ...LIST_RESPONSE,
      artifacts: [idless],
    });
    const onArtifactEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <ArtifactGallery onArtifactEdit={onArtifactEdit} />
      </TestWrapper>
    );

    await openEdit(user);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('This artifact has no stable id to edit'), {
      timeout: 5000,
    });
    expect(onArtifactEdit).not.toHaveBeenCalled();
    // No hydration attempted: an empty id would have fetched the list endpoint by accident.
    const hydrationCalls = mocks.apiGet.mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('includeContent=true')
    );
    expect(hydrationCalls).toHaveLength(0);
  });

  it('ignores a re-entrant Edit click while a hydration fetch is already in flight', async () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise<unknown>(res => {
      resolveFetch = res;
    });
    wireApi(() => pending as Promise<{ data: unknown }>);
    const onArtifactEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <ArtifactGallery onArtifactEdit={onArtifactEdit} />
      </TestWrapper>
    );

    await openEdit(user); // first click: hydration starts and stays pending
    await openEdit(user); // second click while in flight: must be dropped

    resolveFetch({ data: { content: { content: '<h1>hydrated</h1>' } } });

    // The outcome that matters: one editor opened, not two. Without the guard both clicks resolve
    // off the same pending promise and this fires twice.
    await waitFor(() => expect(onArtifactEdit).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });
});

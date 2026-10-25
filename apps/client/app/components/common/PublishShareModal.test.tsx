import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { PublishShareModal } from './PublishShareModal';
import { AccessGateEditor } from './AccessGateEditor';
import { PUBLISH_ACCESS_META, type PublishAccess } from './PublishAccessBadge';
import type { PublishResult, PublishVisibility } from '@bike4mind/common';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

// Mock the axios instance so we can assert the exact comment-policy PATCH an update issues
// (the restricted->open widening regression). Mocking at the transport level keeps the real
// publishApi helpers, whose URL/body shape is what we're verifying.
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));
import { api } from '@client/app/contexts/ApiContext';
const apiPatch = api.patch as unknown as ReturnType<typeof vi.fn>;
const apiPost = api.post as unknown as ReturnType<typeof vi.fn>;
const apiDelete = api.delete as unknown as ReturnType<typeof vi.fn>;

const appTheme = extendTheme({ ...getThemeConfig() });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

// One client for the file, emptied after each test so no cached query outlives the test that made it.
afterEach(() => queryClient.clear());

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
    expect((screen.getByTestId('publish-share-comments-toggle') as HTMLInputElement).checked).toBe(false);
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
    expect((screen.getByTestId('publish-share-comments-toggle') as HTMLInputElement).checked).toBe(true);
  });
});

describe('PublishShareModal - immediate stored gate updates before readback', () => {
  const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
  afterEach(() => {
    apiGet.mockReset();
    apiPatch.mockReset().mockResolvedValue({ data: {} });
    apiPost.mockReset().mockResolvedValue({ data: {} });
    vi.mocked(toast.warning).mockClear();
  });
  const publication: PublishResult = {
    publicId: 'gate-state',
    url: '/p/u/u1/gate-state',
    tier: 'user',
    scopeId: 'u1',
    slug: 'gate-state',
    visibility: 'public',
    publishedAt: '2026-01-01T00:00:00.000Z',
  };
  const gates = [
    {
      kind: 'passphrase',
      stored: { kind: 'passphrase' },
      input: { kind: 'passphrase', passphrase: 'correct horse' },
      who: 'who also has the passphrase',
      viewersWho: 'who also have the passphrase',
      icon: 'KeyIcon',
    },
    {
      kind: 'domain',
      stored: { kind: 'domain', allowedDomains: ['example.com'] },
      input: { kind: 'domain', allowedDomains: ['example.com'] },
      who: 'who signs in with a verified email from an allowed domain',
      viewersWho: 'who sign in with a verified email from an allowed domain',
      icon: 'DomainIcon',
    },
  ] as const;

  const mockPendingReadback = (reopenedGate?: (typeof gates)[number]['stored']) => {
    // Only reopening's first record read resolves. Later seed reads cannot repair a missing local update.
    const pendingReadback = new Promise<never>(() => {});
    apiGet.mockReset().mockImplementation(() => pendingReadback);
    if (reopenedGate) {
      apiGet.mockResolvedValueOnce({
        data: { artifact: { visibility: 'private', accessGate: reopenedGate, commentPolicy: 'none' } },
      });
    }
    apiGet.mockImplementation((url: string) =>
      url.endsWith('/share-token') ? Promise.resolve({ data: { shareToken: null, shareLinks: [] } }) : pendingReadback
    );
    apiPatch.mockReset().mockResolvedValue({ data: {} });
    apiPost.mockReset().mockResolvedValue({ data: { shareToken: 'TOK', shareUrl: '/a/TOK' } });
  };

  const renderModal = (props: Partial<React.ComponentProps<typeof PublishShareModal>> = {}) =>
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={vi.fn().mockResolvedValue(publication)}
          title="My artifact"
          {...props}
        />
      </Wrapper>
    );

  const stageGate = (kind: 'passphrase' | 'domain') => {
    fireEvent.click(radio(kind)!);
    if (kind === 'passphrase') {
      const passphrase = screen
        .getAllByTestId('publish-share-gate-passphrase')
        .find(element => element instanceof HTMLInputElement && element.type === 'password');
      expect(passphrase).toBeDefined();
      fireEvent.change(passphrase!, { target: { value: 'correct horse' } });
      return;
    }
    fireEvent.change(screen.getByTestId('publish-share-gate-domains'), { target: { value: 'example.com' } });
  };

  const expectGatedPrivateLink = async (gate: (typeof gates)[number], { visibilityHint = true } = {}) => {
    const createLink = await screen.findByTestId('publish-share-token-create');
    expect(createLink.textContent).toBe('Create private link');
    expect(screen.getByTestId('publish-share-token-label').textContent).toBe('Private link');
    expect(screen.getByTestId('publish-share-token-hint').textContent).toContain(gate.who);
    expect(screen.getByTestId('publish-share-token-hint').textContent).not.toContain('without signing in');
    if (visibilityHint)
      expect(screen.getByTestId('publish-share-visibility-private-hint').textContent).toBe(
        `Only you, and anyone you send a private link to. Private links open only for viewers ${gate.viewersWho}.`
      );
    fireEvent.click(createLink);
    const warning = await screen.findByTestId('publish-share-token-warning');
    expect(warning.getAttribute('data-access')).toBe(gate.kind);
    expect(warning.textContent).toBe(`Anyone with this link ${gate.who} can view.`);
    expect(within(warning).getByTestId(gate.icon)).toBeTruthy();
  };

  it.each(gates)('uses the reopened $kind gate while the follow-up seed GET is pending', async gate => {
    mockPendingReadback(gate.stored);
    renderModal({ resolvePublished: () => Promise.resolve(publication) });
    await screen.findByTestId('publish-share-url');
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/publish/artifacts/gate-state'));
    await expectGatedPrivateLink(gate);
  });

  it.each([
    { mode: 'new', gate: gates[0] },
    { mode: 'update', gate: gates[1] },
  ] as const)(
    'uses a staged $gate.kind gate after $mode publish while the seed GET is pending',
    async ({ mode, gate }) => {
      mockPendingReadback();
      const publish = vi.fn().mockResolvedValue(publication);
      renderModal({
        publish,
        ...(mode === 'update'
          ? {
              resolveExisting: () =>
                Promise.resolve({ title: 'My artifact', slug: 'gate-state', visibility: 'public' as const }),
            }
          : {}),
      });
      if (mode === 'update') await screen.findByTestId('publish-share-mode-update');
      stageGate(gate.kind);
      fireEvent.click(screen.getByTestId('publish-share-create'));
      await screen.findByTestId('publish-share-url');
      expect(publish).toHaveBeenCalledWith('public', {
        mode,
        existingSlug: mode === 'update' ? 'gate-state' : undefined,
      });
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/gate-state', { accessGate: gate.input });
      fireEvent.click(screen.getByTestId('publish-share-visibility-private'));
      await expectGatedPrivateLink(gate);
    }
  );

  it.each(gates)('uses a $kind gate applied live while the seed GET is pending', async gate => {
    mockPendingReadback();
    renderModal();
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-url');
    stageGate(gate.kind);
    fireEvent.click(screen.getByTestId('publish-share-gate-apply'));
    await waitFor(() => expect(screen.queryByTestId('publish-share-gate-apply')).toBeNull());
    expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/gate-state', { accessGate: gate.input });
    fireEvent.click(screen.getByTestId('publish-share-visibility-private'));
    await expectGatedPrivateLink(gate);
  });

  // The stored gate must come from the reopened record or the successful PATCH itself: a seed GET that
  // never succeeds cannot be what makes the gated copy appear.
  const mockFailingSeedRead = (reopenedGate?: (typeof gates)[number]['stored']) => {
    mockPendingReadback();
    if (reopenedGate) {
      apiGet.mockResolvedValueOnce({
        data: { artifact: { visibility: 'private', accessGate: reopenedGate, commentPolicy: 'none' } },
      });
    }
    apiGet.mockImplementation((url: string) =>
      url.endsWith('/share-token')
        ? Promise.resolve({ data: { shareToken: null, shareLinks: [] } })
        : Promise.reject(new Error('Record unavailable'))
    );
  };

  it.each(gates)('uses the reopened $kind gate when the follow-up seed GET fails', async gate => {
    mockFailingSeedRead(gate.stored);
    renderModal({ resolvePublished: () => Promise.resolve(publication) });
    await screen.findByTestId('publish-share-url');
    await expectGatedPrivateLink(gate, { visibilityHint: false });
  });

  it.each(gates)('uses a staged $kind gate after publish when the seed GET fails', async gate => {
    mockFailingSeedRead();
    renderModal();
    stageGate(gate.kind);
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-url');
    expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/gate-state', { accessGate: gate.input });
    fireEvent.click(screen.getByTestId('publish-share-visibility-private'));
    await expectGatedPrivateLink(gate, { visibilityHint: false });
  });

  it('keeps the live passphrase gate when an older ungated seed read arrives afterward', async () => {
    mockPendingReadback();
    const seedRead = Promise.withResolvers<{ data: { artifact: { accessGate: null } } }>();
    apiGet.mockImplementation((url: string) =>
      url.endsWith('/share-token') ? Promise.resolve({ data: { shareToken: 'TOK', shareLinks: [] } }) : seedRead.promise
    );
    renderModal();
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-url');
    stageGate('passphrase');
    fireEvent.click(screen.getByTestId('publish-share-gate-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('publish-share-token-warning').getAttribute('data-access')).toBe('passphrase')
    );
    await act(async () => seedRead.resolve({ data: { artifact: { accessGate: null } } }));
    expect(screen.getByTestId('publish-share-token-warning').getAttribute('data-access')).toBe('passphrase');
    expect(screen.getByTestId('publish-share-token-warning').textContent).toContain('who also has the passphrase');
    expect(screen.queryByTestId('publish-share-embed-section')).toBeNull();
  });

  it('keeps a cleared live gate when an older gated seed read arrives afterward', async () => {
    mockPendingReadback();
    const seedRead = Promise.withResolvers<{ data: { artifact: { accessGate: { kind: 'passphrase' } } } }>();
    apiGet.mockImplementation((url: string) =>
      url.endsWith('/share-token') ? Promise.resolve({ data: { shareToken: 'TOK', shareLinks: [] } }) : seedRead.promise
    );
    renderModal();
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-url');
    fireEvent.click(radio('passphrase')!);
    fireEvent.click(radio('none')!);
    fireEvent.click(screen.getByTestId('publish-share-gate-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('publish-share-token-warning').textContent).toBe(
        'Anyone with this link can view without signing in.'
      )
    );
    await act(async () => seedRead.resolve({ data: { artifact: { accessGate: { kind: 'passphrase' } } } }));
    expect(screen.getByTestId('publish-share-token-warning').getAttribute('data-access')).toBe('public');
    expect(screen.getByTestId('publish-share-token-warning').textContent).toBe(
      'Anyone with this link can view without signing in.'
    );
    expect(screen.getByTestId('publish-share-embed-section')).toBeTruthy();
  });

  it.each([
    { mode: 'published', visibility: 'private' },
    { mode: 'reopened', visibility: 'private' },
    { mode: 'published', visibility: 'public' },
    { mode: 'reopened', visibility: 'public' },
  ] as const)(
    'does not promise ungated access when a $mode $visibility publication record cannot be read',
    async ({ mode, visibility }) => {
      mockPendingReadback();
      apiGet.mockImplementation((url: string) =>
        url.endsWith('/share-token')
          ? Promise.resolve({ data: { shareToken: 'TOK', shareLinks: [] } })
          : Promise.reject(new Error('Record unavailable'))
      );
      const unreadPublication = { ...publication, visibility };
      renderModal({
        defaultVisibility: visibility,
        publish: vi.fn().mockResolvedValue(unreadPublication),
        ...(mode === 'reopened' ? { resolvePublished: () => Promise.resolve(unreadPublication) } : {}),
      });
      if (mode === 'published') fireEvent.click(screen.getByTestId('publish-share-create'));
      const warning = await screen.findByTestId('publish-share-token-warning');
      expect(warning.textContent).toBe('Access settings are unavailable. Check access before sharing this link.');
      expect(warning.textContent).not.toContain('without signing in');
      expect(warning.getAttribute('data-access')).not.toBe('public');
      expect(screen.getByTestId('publish-share-token-label').textContent).toBe('Private link');
      expect(screen.getByTestId('publish-share-token-hint').textContent).not.toContain('without signing in');
      expect(screen.queryByTestId('publish-share-embed-section')).toBeNull();
      expect(screen.queryByTestId('publish-share-public-note')).toBeNull();
      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith('Could not refresh access settings. Check access before sharing.')
      );
    }
  );
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
    expect((screen.getByTestId('publish-share-comments-toggle') as HTMLInputElement).checked).toBe(true);

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
    expect((screen.getByTestId('publish-share-comments-toggle') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId('publish-share-create'));

    // No comment-policy PATCH fires - the record keeps the server default 'none'.
    await screen.findByTestId('publish-share-url');
    expect(apiPatch).not.toHaveBeenCalled();
  });
});

describe('PublishShareModal — Team (organization) visibility option', () => {
  const publishResult: PublishResult = {
    publicId: 'pub-org',
    url: '/p/o/org_42/s',
    tier: 'organization',
    scopeId: 'org_42',
    slug: 's',
    visibility: 'organization',
    publishedAt: '2026-01-01T00:00:00.000Z',
  };

  it('omits the Team option when no orgOption is given (personal context)', () => {
    render(
      <Wrapper>
        <PublishShareModal open onClose={() => {}} publish={noopPublish} title="My artifact" />
      </Wrapper>
    );
    expect(radio('public')).not.toBeNull();
    expect(radio('private')).not.toBeNull();
    expect(radio('organization')).toBeNull();
  });

  it('offers the Team option and publishes with organization visibility when picked', async () => {
    const publish = vi.fn().mockResolvedValue(publishResult);
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={publish}
          title="My artifact"
          defaultVisibility="public"
          orgOption={{ label: 'Team', hint: 'Members of Acme' }}
        />
      </Wrapper>
    );

    const orgRadio = radio('organization');
    expect(orgRadio).not.toBeNull();

    fireEvent.click(orgRadio!);
    fireEvent.click(screen.getByTestId('publish-share-create'));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    // The dialog hands 'organization' to the publish callback, which maps it to an org-tier page.
    expect(publish).toHaveBeenCalledWith('organization', expect.objectContaining({ mode: 'new' }));
  });

  it('does NOT offer Team in the shared phase after a user-tier publish (would 403 org members)', async () => {
    // Regression: a user-tier page live-switched to org visibility is served only where
    // scopeId === viewer.organizationId; scopeId is the user id, so org members get 403.
    // Moving to org scope requires re-publishing, not a visibility PATCH - so Team must not
    // be offered on a user-tier record in the shared phase.
    const userTierResult: PublishResult = {
      publicId: 'pub-user',
      url: '/p/u/u1/s',
      tier: 'user',
      scopeId: 'u1',
      slug: 's',
      visibility: 'public',
      publishedAt: '2026-01-01T00:00:00.000Z',
    };
    const publish = vi.fn().mockResolvedValue(userTierResult);
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={publish}
          title="My artifact"
          defaultVisibility="public"
          orgOption={{ label: 'Team', hint: 'Members of Acme' }}
        />
      </Wrapper>
    );

    // Choose phase: Team is offered.
    expect(radio('organization')).not.toBeNull();
    fireEvent.click(screen.getByTestId('publish-share-create'));

    // Shared phase (user-tier result): Team is withdrawn; only Public/Private remain.
    await screen.findByTestId('publish-share-url');
    expect(radio('public')).not.toBeNull();
    expect(radio('private')).not.toBeNull();
    expect(radio('organization')).toBeNull();
  });

  it('offers Public, Team and Private in the shared phase after an org-tier publish', async () => {
    // org-tier record: Private is valid at every tier (SCOPE_POLICY), so the owner can take a
    // Team page back to owner-only from here.
    const publish = vi.fn().mockResolvedValue(publishResult);
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={publish}
          title="My artifact"
          defaultVisibility="public"
          orgOption={{ label: 'Team', hint: 'Members of Acme' }}
        />
      </Wrapper>
    );

    fireEvent.click(radio('organization')!);
    fireEvent.click(screen.getByTestId('publish-share-create'));

    await screen.findByTestId('publish-share-url');
    expect(radio('public')).not.toBeNull();
    expect(radio('organization')).not.toBeNull();
    expect(radio('private')).not.toBeNull();
  });
});

describe('PublishShareModal - domain access gate', () => {
  const publishResult: PublishResult = {
    publicId: 'pub-1',
    url: '/p/u/u1/s',
    tier: 'user',
    scopeId: 'u1',
    slug: 's',
    visibility: 'public',
    publishedAt: '2026-01-01T00:00:00.000Z',
  };

  it('sends the domain gate entries AS ENTERED on publish (subdomain not reduced)', async () => {
    apiPatch.mockClear().mockResolvedValue({ data: {} });
    const publish = vi.fn().mockResolvedValue(publishResult);
    render(
      <Wrapper>
        <PublishShareModal open onClose={() => {}} publish={publish} title="My artifact" defaultVisibility="public" />
      </Wrapper>
    );
    fireEvent.click(radio('domain')!);
    fireEvent.change(screen.getByTestId('publish-share-gate-domains'), { target: { value: 'mail.acme.com' } });
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        accessGate: { kind: 'domain', allowedDomains: ['mail.acme.com'] },
      })
    );
  });
});

describe('PublishShareModal - no-sign-in (/a) share link', () => {
  const publishResult: PublishResult = {
    publicId: 'pub-1',
    url: '/p/u/u1/s',
    tier: 'user',
    scopeId: 'u1',
    slug: 's',
    visibility: 'private',
    publishedAt: '2026-01-01T00:00:00.000Z',
  };

  const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

  const renderShared = async (visibility: PublishVisibility = 'private', liveToken: string | null = null) => {
    apiGet.mockClear().mockImplementation((url: string) =>
      Promise.resolve({
        data: url.endsWith('/share-token') ? { shareToken: liveToken, shareLinks: [] } : { artifact: {} },
      })
    );
    apiPatch.mockClear().mockResolvedValue({ data: {} });
    apiPost.mockClear().mockResolvedValue({ data: { shareToken: 'TOK', shareUrl: '/a/TOK' } });
    apiDelete.mockClear().mockResolvedValue({ data: {} });
    const publish = vi.fn().mockResolvedValue({ ...publishResult, visibility });
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={publish}
          title="My artifact"
          defaultVisibility={visibility}
        />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-url'); // shared phase
  };

  it('hides the section for a public page, whose main link already opens without sign-in', async () => {
    await renderShared('public');
    expect(screen.queryByTestId('publish-share-token-section')).toBeNull();
  });

  it('shows a live link left from a past session on a public page so it can still be revoked', async () => {
    await renderShared('public', 'OLD');
    const input = (await screen.findByTestId('publish-share-token-url')) as HTMLInputElement;
    expect(input.value).toContain('/a/OLD');
    expect(apiGet).toHaveBeenCalledWith('/api/publish/pub-1/share-token');
    expect(apiPost).not.toHaveBeenCalledWith('/api/publish/pub-1/share-token', expect.anything());
    expect(screen.getByTestId('publish-share-token-revoke')).not.toBeNull();
  });

  it('keeps a link minted while private after switching to public, then hides it on revoke', async () => {
    await renderShared();
    fireEvent.click(screen.getByTestId('publish-share-token-create'));
    await screen.findByTestId('publish-share-token-url');

    fireEvent.click(radio('public')!);
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(screen.getByTestId('publish-share-token-hint').textContent).toContain('already opens for anyone');

    fireEvent.click(screen.getByTestId('publish-share-token-revoke'));
    await waitFor(() => expect(screen.queryByTestId('publish-share-token-section')).toBeNull());
  });

  it('says the main link of a private page only opens for the owner', async () => {
    await renderShared();
    await waitFor(() =>
      expect(screen.getByTestId('publish-share-token-hint').textContent).toContain('only opens for you')
    );
  });

  it('mints the /a link on demand and shows it in a copyable field', async () => {
    await renderShared();

    // Lazy: no token until the owner asks. The create button is shown first.
    expect(screen.queryByTestId('publish-share-token-url')).toBeNull();
    fireEvent.click(screen.getByTestId('publish-share-token-create'));

    const input = (await screen.findByTestId('publish-share-token-url')) as HTMLInputElement;
    expect(input.value).toContain('/a/TOK');
    expect(apiPost).toHaveBeenCalledWith('/api/publish/pub-1/share-token', { regenerate: false });
  });

  it('regenerate rotates the token (regenerate:true)', async () => {
    await renderShared();
    fireEvent.click(screen.getByTestId('publish-share-token-create'));
    await screen.findByTestId('publish-share-token-url');

    apiPost.mockResolvedValueOnce({ data: { shareToken: 'TOK2', shareUrl: '/a/TOK2' } });
    fireEvent.click(screen.getByTestId('publish-share-token-regenerate'));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/publish/pub-1/share-token', { regenerate: true }));
  });

  it('revoke drops the token and returns to the create affordance', async () => {
    await renderShared();
    fireEvent.click(screen.getByTestId('publish-share-token-create'));
    await screen.findByTestId('publish-share-token-url');

    fireEvent.click(screen.getByTestId('publish-share-token-revoke'));

    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/publish/pub-1/share-token'));
    await waitFor(() => expect(screen.queryByTestId('publish-share-token-url')).toBeNull());
    expect(screen.getByTestId('publish-share-token-create')).not.toBeNull();
  });
});

describe('PublishShareModal - embed allowlist', () => {
  const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
  const publishResult: PublishResult = {
    publicId: 'pub-1',
    url: '/p/u/u1/s',
    tier: 'user',
    scopeId: 'u1',
    slug: 's',
    visibility: 'public',
    publishedAt: '2026-01-01T00:00:00.000Z',
  };

  const renderShared = async (seed: { embedOrigins?: string[]; accessGate?: unknown } = {}) => {
    apiGet.mockClear().mockResolvedValue({
      data: { artifact: { embedOrigins: seed.embedOrigins ?? [], accessGate: seed.accessGate ?? null } },
    });
    apiPatch.mockClear().mockResolvedValue({ data: {} });
    const publish = vi.fn().mockResolvedValue(publishResult);
    render(
      <Wrapper>
        <PublishShareModal open onClose={() => {}} publish={publish} title="My artifact" defaultVisibility="public" />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-url'); // shared phase
  };

  it('adds a valid origin, PATCHing the allowlist and showing a chip', async () => {
    await renderShared();
    await screen.findByTestId('publish-share-embed-section');

    const input = screen.getByTestId('publish-share-embed-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://erikbethke.com' } });
    fireEvent.click(screen.getByTestId('publish-share-embed-add'));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        embedOrigins: ['https://erikbethke.com'],
      })
    );
    await screen.findByTestId('publish-share-embed-chip-https://erikbethke.com');
    // The copy-paste iframe snippet appears once an origin is allowed.
    expect((screen.getByTestId('publish-share-embed-snippet') as HTMLTextAreaElement).value).toContain(
      '/p/u/u1/s?embed=1'
    );
  });

  it('seeds existing origins and removes one (PATCHing the reduced list)', async () => {
    await renderShared({ embedOrigins: ['https://erikbethke.com'] });
    await screen.findByTestId('publish-share-embed-chip-https://erikbethke.com');

    fireEvent.click(screen.getByTestId('publish-share-embed-remove-https://erikbethke.com'));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { embedOrigins: [] }));
  });

  it('rejects a non-https origin client-side (no PATCH)', async () => {
    await renderShared();
    await screen.findByTestId('publish-share-embed-section');

    const input = screen.getByTestId('publish-share-embed-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'http://insecure.com' } });
    fireEvent.click(screen.getByTestId('publish-share-embed-add'));

    // No embedOrigins PATCH (other unrelated PATCHes may fire on entering shared phase).
    expect(apiPatch.mock.calls.some(([, body]) => body && 'embedOrigins' in body)).toBe(false);
  });

  it('hides the embed section while a gate is live', async () => {
    await renderShared({ accessGate: { kind: 'domain', allowedDomains: ['milliononmars.com'] } });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByTestId('publish-share-embed-section')).toBeNull();
  });
});

/**
 * Pre-publish completeness gate. A /p/ link can be handed to a teammate before anyone
 * notices the artifact's controls are inert, so the warning is acknowledge-to-proceed
 * rather than passive - but never a hard block, since the signal is a heuristic.
 */
describe('PublishShareModal - incomplete-artifact warning', () => {
  const renderWith = (incompleteWarning?: string) =>
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={noopPublish}
          title="My artifact"
          incompleteWarning={incompleteWarning}
        />
      </Wrapper>
    );

  it('shows nothing and leaves publish enabled when the content looks complete', () => {
    renderWith(undefined);

    expect(screen.queryByTestId('publish-share-incomplete-warning')).toBeNull();
    expect(screen.getByTestId('publish-share-create')).not.toBeDisabled();
  });

  it('disables publish until the warning is acknowledged', () => {
    renderWith('Parts of this artifact look like placeholders.');

    expect(screen.getByTestId('publish-share-incomplete-warning')).toBeInTheDocument();
    expect(screen.getByTestId('publish-share-create')).toBeDisabled();

    fireEvent.click(screen.getByTestId('publish-share-incomplete-ack'));

    expect(screen.getByTestId('publish-share-create')).not.toBeDisabled();
  });

  it('does not publish while the warning stands unacknowledged', () => {
    renderWith('Parts of this artifact look like placeholders.');

    fireEvent.click(screen.getByTestId('publish-share-create'));

    expect(noopPublish).not.toHaveBeenCalled();
  });
});

describe('PublishShareModal — search-engine listing is opt-in', () => {
  const renderModal = (props: Partial<React.ComponentProps<typeof PublishShareModal>> = {}) =>
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={noopPublish}
          title="My artifact"
          defaultVisibility="public"
          {...props}
        />
      </Wrapper>
    );

  it('defaults the search-listing toggle to OFF for a fresh public publish', () => {
    renderModal();
    const toggle = screen.getByTestId('publish-share-discoverable-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('keeps the switch from shrinking beside the long helper text on a narrow viewport', () => {
    renderModal();
    expect(getComputedStyle(screen.getByTestId('publish-share-discoverable-switch')).flexShrink).toBe('0');
    const textColumn = getComputedStyle(screen.getByTestId('publish-share-discoverable-text'));
    expect(textColumn.flexGrow).toBe('1');
    expect(textColumn.minWidth).toBe('0px');
  });

  it('tells the user a public link stays out of search engines by default', () => {
    renderModal();
    // The public warning must say what "public" does NOT mean - this is the exact
    // expectation gap that made "anyone with the link" read as "unlisted".
    expect(screen.getByText(/stays out of search engines unless you turn on/i)).toBeTruthy();
    expect(screen.getByText(/won't show up in Google/i)).toBeTruthy();
  });

  it('hides the toggle for a private item - it could never take effect there', () => {
    renderModal({ defaultVisibility: 'private' });
    expect(screen.queryByTestId('publish-share-discoverable-toggle')).toBeNull();
  });

  it('seeds the toggle ON from a prior publication that opted in', async () => {
    renderModal({
      resolveExisting: () =>
        Promise.resolve({
          title: 'My artifact',
          versionsCount: 1,
          slug: 's',
          visibility: 'public',
          commentPolicy: 'none',
          discoverable: true,
        }),
    });
    await waitFor(() => {
      const toggle = screen.getByTestId('publish-share-discoverable-toggle') as HTMLInputElement;
      expect(toggle.checked).toBe(true);
    });
  });

  it('drops a staged listing choice when the user switches away from Public', () => {
    // Otherwise the flag is parked on a hidden control and silently arms itself the
    // next time someone widens the artifact back to public.
    renderModal();
    fireEvent.click(screen.getByTestId('publish-share-discoverable-toggle'));
    expect((screen.getByTestId('publish-share-discoverable-toggle') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByTestId('publish-share-visibility-private'));
    expect(screen.queryByTestId('publish-share-discoverable-toggle')).toBeNull();

    // Back to Public: starts from OFF, not from the stale staged choice.
    fireEvent.click(screen.getByTestId('publish-share-visibility-public'));
    expect((screen.getByTestId('publish-share-discoverable-toggle') as HTMLInputElement).checked).toBe(false);
  });

  it('keeps the staged listing choice consistent with storage across a gate round-trip', () => {
    // Review point (c): resetting on a gate PICK was local-only, because a gate is not
    // persisted until "Update access". That made the switch read OFF while storage still
    // said true. The switch now holds its value; what stops a gated artifact from being
    // persisted as listed is the publish-time guard (covered separately below).
    renderModal();
    fireEvent.click(screen.getByTestId('publish-share-discoverable-toggle'));

    fireEvent.click(radio('passphrase')!);
    expect(screen.queryByTestId('publish-share-discoverable-toggle')).toBeNull();

    fireEvent.click(radio('none')!);
    expect((screen.getByTestId('publish-share-discoverable-toggle') as HTMLInputElement).checked).toBe(true);
  });

  const publishAndWait = async (props: Partial<React.ComponentProps<typeof PublishShareModal>> = {}) => {
    const publish = vi.fn().mockResolvedValue({ publicId: 'pub-1', url: '/p/u/me/s', tier: 'user' });
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={publish}
          title="My artifact"
          defaultVisibility="public"
          {...props}
        />
      </Wrapper>
    );
    return publish;
  };

  it('PATCHes discoverable:true after publishing when the switch was staged ON', async () => {
    // The feature's primary happy path: stage ON, publish, artifact becomes discoverable.
    apiPatch.mockClear().mockResolvedValue({ data: {} });
    await publishAndWait();
    fireEvent.click(screen.getByTestId('publish-share-discoverable-toggle'));
    fireEvent.click(screen.getByTestId('publish-share-create'));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { discoverable: true }));
  });

  it('does NOT PATCH discoverable:true when a gate was staged alongside it', async () => {
    // The `gateKind === 'none'` conjunct is load-bearing: persisting true on a gated
    // artifact would arm a silent opt-in for whenever the gate is later removed.
    apiPatch.mockClear().mockResolvedValue({ data: {} });
    await publishAndWait();
    fireEvent.click(screen.getByTestId('publish-share-discoverable-toggle'));
    fireEvent.click(radio('passphrase')!);
    // The gate radio and the passphrase Input share this testid, so query by input type.
    fireEvent.change(document.querySelector('input[type="password"]')!, {
      target: { value: 'a-long-enough-passphrase' },
    });
    fireEvent.click(screen.getByTestId('publish-share-create'));

    await waitFor(() => expect(screen.queryByTestId('publish-share-url')).not.toBeNull());
    expect(apiPatch).not.toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { discoverable: true });
  });

  it('PATCHes discoverable:false to DE-LIST a previously-listed artifact', async () => {
    // finalize does not $set discoverable, so a re-publish preserves it - the OFF
    // direction has to be written explicitly or the dialog can never turn it off.
    apiPatch.mockClear().mockResolvedValue({ data: {} });
    await publishAndWait({
      resolveExisting: () =>
        Promise.resolve({
          title: 'My artifact',
          versionsCount: 1,
          slug: 's',
          visibility: 'public',
          commentPolicy: 'none',
          discoverable: true,
        }),
    });
    // Wait for seeding, then switch it off before publishing.
    await waitFor(() =>
      expect((screen.getByTestId('publish-share-discoverable-toggle') as HTMLInputElement).checked).toBe(true)
    );
    fireEvent.click(screen.getByTestId('publish-share-discoverable-toggle'));
    fireEvent.click(screen.getByTestId('publish-share-create'));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { discoverable: false }));
  });

  it('rolls the live toggle back when the PATCH fails', async () => {
    await publishAndWait();
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-url');

    apiPatch.mockClear().mockRejectedValueOnce(new Error('nope'));
    fireEvent.click(screen.getByTestId('publish-share-discoverable-toggle'));
    await waitFor(() =>
      expect((screen.getByTestId('publish-share-discoverable-toggle') as HTMLInputElement).checked).toBe(false)
    );
  });

  it('does not PATCH discoverable while still staging a fresh publish', () => {
    apiPatch.mockClear();
    renderModal();
    fireEvent.click(screen.getByTestId('publish-share-discoverable-toggle'));
    // Nothing exists to PATCH yet; the choice is applied after publish succeeds.
    expect(apiPatch).not.toHaveBeenCalledWith(expect.stringContaining('/api/publish/artifacts/'), {
      discoverable: true,
    });
  });
});

describe('PublishShareModal - plain-language copy', () => {
  it('labels the default option in plain words with no warning glyph', () => {
    render(
      <Wrapper>
        <PublishShareModal open onClose={() => {}} publish={vi.fn()} title="My artifact" defaultVisibility="public" />
      </Wrapper>
    );
    const option = screen.getByTestId('publish-share-visibility-public');
    expect(option.textContent).toContain('Anyone with the link');
    expect(document.body.textContent).not.toContain('\u26a0');
    expect(document.body.textContent).not.toContain('List in search engines');
    // The gate options name the same secret the passphrase option asks for.
    expect(document.body.textContent).not.toContain('passcode');
  });
});

describe('PublishShareModal - publish failure toast', () => {
  const rejectWith = (status: number, data: unknown) =>
    vi.fn().mockRejectedValue(
      new AxiosError(
        'Request failed',
        'ERR_BAD_REQUEST',
        undefined,
        {},
        {
          status,
          statusText: '',
          data,
          headers: {},
          config: { headers: new AxiosHeaders() },
        }
      )
    );

  const publishAndFail = async (publish: ReturnType<typeof vi.fn>) => {
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => 1);
    toastError.mockClear();
    render(
      <Wrapper>
        <PublishShareModal open onClose={() => {}} publish={publish} title="My artifact" defaultVisibility="private" />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const [message] = toastError.mock.calls[0];
    toastError.mockRestore();
    return message;
  };

  it("shows the validator's reason rather than the bare 'Validation failed'", async () => {
    const message = await publishAndFail(
      rejectWith(422, {
        error: 'Validation failed',
        violations: [
          { type: 'forbidden_pattern', message: 'Provide a single self-contained component.', file: 'index.html' },
        ],
      })
    );

    expect(message).toBe('Provide a single self-contained component.');
  });

  it('keeps the server error for a failure without violations', async () => {
    expect(await publishAndFail(rejectWith(403, { error: 'Not allowed to publish here' }))).toBe(
      'Not allowed to publish here'
    );
  });
});

describe('PublishShareModal - reopening an already-published reply', () => {
  const live: PublishResult = {
    publicId: 'live-1',
    url: '/p/r/live-1',
    tier: 'user',
    scopeId: 'u1',
    slug: 'r-live-1',
    visibility: 'public',
    publishedAt: '2026-01-01T00:00:00.000Z',
  };
  const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

  const renderReopened = (resolvePublished: () => Promise<PublishResult | null>) => {
    apiGet.mockReset().mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/share-token')
          ? { data: { shareToken: null } }
          : {
              data: {
                artifact: { visibility: 'public', accessGate: null, commentPolicy: 'none', discoverable: false },
              },
            }
      )
    );
    apiPatch.mockClear().mockResolvedValue({ data: {} });
    const publish = vi.fn();
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={publish}
          title="An answer"
          resolvePublished={resolvePublished}
        />
      </Wrapper>
    );
    return publish;
  };

  it('opens on the existing link and its current visibility, not a blank form', async () => {
    renderReopened(() => Promise.resolve(live));
    const url = (await screen.findByTestId('publish-share-url')) as HTMLInputElement;
    expect(url.value).toContain('/p/r/live-1');
    expect(radio('public')?.checked).toBe(true);
    expect(screen.getByTestId('publish-share-intro').textContent).not.toContain('Nothing is published');
  });

  it('choosing Private PATCHes the existing record instead of publishing again', async () => {
    const publish = renderReopened(() => Promise.resolve(live));
    await screen.findByTestId('publish-share-url');
    fireEvent.click(screen.getByTestId('publish-share-visibility-private'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/live-1', { visibility: 'private' })
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('holds the create button until the lookup settles, then falls back to the publish form', async () => {
    let settle: (v: PublishResult | null) => void = () => {};
    renderReopened(() => new Promise(r => (settle = r)));
    expect((screen.getByTestId('publish-share-create') as HTMLButtonElement).disabled).toBe(true);
    settle(null);
    await waitFor(() => expect((screen.getByTestId('publish-share-create') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId('publish-share-url')).toBeNull();
  });

  it('reopening seeds every control from the record, not from the lookup row', async () => {
    renderReopened(() => Promise.resolve({ ...live, visibility: 'public' }));
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/share-token')
          ? { data: { shareToken: 'tok-zq9' } }
          : {
              data: {
                artifact: {
                  visibility: 'private',
                  accessGate: { kind: 'domain', allowedDomains: ['example.com'] },
                  commentPolicy: 'open',
                  discoverable: true,
                },
              },
            }
      )
    );
    await screen.findByTestId('publish-share-url');
    await waitFor(() => expect(radio('private')?.checked).toBe(true));
    expect(radio('public')?.checked).toBe(false);
    expect((screen.getByTestId('publish-share-comments-toggle') as HTMLInputElement).checked).toBe(true);
    expect(((await screen.findByTestId('publish-share-token-url')) as HTMLInputElement).value).toContain('/a/tok-zq9');
    // The gate control only renders while public; switching there shows the seeded gate.
    fireEvent.click(screen.getByTestId('publish-share-visibility-public'));
    const domains = (await screen.findByTestId('publish-share-gate-domains')) as HTMLInputElement;
    expect(domains.value).toBe('example.com');
  });

  it('reopening seeds the search-listing switch from the record when it is public and ungated', async () => {
    renderReopened(() => Promise.resolve({ ...live, visibility: 'private' }));
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/share-token')
          ? { data: { shareToken: null } }
          : {
              data: {
                artifact: { visibility: 'public', accessGate: null, commentPolicy: 'none', discoverable: true },
              },
            }
      )
    );
    await screen.findByTestId('publish-share-url');
    await waitFor(() => expect(radio('public')?.checked).toBe(true));
    expect((screen.getByTestId('publish-share-discoverable-toggle') as HTMLInputElement).checked).toBe(true);
  });

  it('reopening still shows the link and lookup visibility when the record read fails', async () => {
    renderReopened(() => Promise.resolve({ ...live, visibility: 'private' }));
    apiGet.mockImplementation((url: string) =>
      url.endsWith('/share-token') ? Promise.resolve({ data: { shareToken: null } }) : Promise.reject(new Error('boom'))
    );
    const url = (await screen.findByTestId('publish-share-url')) as HTMLInputElement;
    expect(url.value).toContain('/p/r/live-1');
    await waitFor(() => expect(radio('private')?.checked).toBe(true));
  });

  it('reopening falls back to the publish form when the lookup rejects', async () => {
    renderReopened(() => Promise.reject(new Error('x')));
    await waitFor(() => expect((screen.getByTestId('publish-share-create') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId('publish-share-url')).toBeNull();
    expect(screen.queryByText(/Checking/)).toBeNull();
  });

  it('a reopened Team page shows Team as selected even outside a team context', async () => {
    renderReopened(() =>
      Promise.resolve({ ...live, tier: 'organization', scopeId: 'org1', visibility: 'organization' })
    );
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/share-token')
          ? { data: { shareToken: null } }
          : {
              data: {
                artifact: { visibility: 'organization', accessGate: null, commentPolicy: 'none', discoverable: false },
              },
            }
      )
    );
    await screen.findByTestId('publish-share-url');
    await waitFor(() => expect(radio('organization')?.checked).toBe(true));
    expect(radio('public')?.checked).toBe(false);
    expect(radio('private')?.checked).toBe(false);
    // With no caller hint, the Team row says what the access badge says.
    expect(screen.getByTestId('publish-share-visibility-organization').textContent).toContain(
      PUBLISH_ACCESS_META.organization.description
    );
  });

  it('a reopened Team page can be taken to Private on the same record', async () => {
    const publish = renderReopened(() =>
      Promise.resolve({ ...live, tier: 'organization', scopeId: 'org1', visibility: 'organization' })
    );
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/share-token')
          ? { data: { shareToken: null } }
          : {
              data: {
                artifact: { visibility: 'organization', accessGate: null, commentPolicy: 'none', discoverable: false },
              },
            }
      )
    );
    await screen.findByTestId('publish-share-url');
    await waitFor(() => expect(radio('organization')?.checked).toBe(true));
    fireEvent.click(screen.getByTestId('publish-share-visibility-private'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/live-1', { visibility: 'private' })
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('closing mid-lookup does not hold the create button on the next open without a lookup', async () => {
    const publish = vi.fn();
    const { rerender } = render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={publish}
          title="An answer"
          resolvePublished={() => new Promise<PublishResult | null>(() => {})}
        />
      </Wrapper>
    );
    expect((screen.getByTestId('publish-share-create') as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <Wrapper>
        <PublishShareModal open={false} onClose={() => {}} publish={publish} title="An answer" />
      </Wrapper>
    );
    rerender(
      <Wrapper>
        <PublishShareModal open onClose={() => {}} publish={publish} title="An artifact" />
      </Wrapper>
    );
    await waitFor(() => expect((screen.getByTestId('publish-share-create') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('publish-share-intro').textContent).not.toContain('Checking');
  });
});

describe('PublishShareModal - access options match the Live Artifacts badge', () => {
  // MUI icons carry their component name as a test id, so this pins which icon each option draws.
  const ICON_TEST_ID: Record<PublishAccess, string> = {
    public: 'PublicIcon',
    passphrase: 'KeyIcon',
    domain: 'DomainIcon',
    organization: 'GroupIcon',
    project: 'FolderIcon',
    private: 'LockIcon',
  };

  const renderModal = (
    props: Partial<React.ComponentProps<typeof PublishShareModal>> = {},
    mode: 'light' | 'dark' = 'light'
  ) =>
    render(
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={appTheme} defaultMode={mode} modeStorageKey={`share-modal-test-${mode}`}>
          <PublishShareModal
            open
            onClose={() => {}}
            publish={noopPublish}
            title="My artifact"
            defaultVisibility="public"
            orgOption={{ label: 'Team', hint: 'Members of Acme' }}
            {...props}
          />
        </CssVarsProvider>
      </QueryClientProvider>
    );

  const expectAccessIcon = (testId: string, access: PublishAccess) => {
    const icon = screen.getByTestId(testId);
    expect(icon.getAttribute('data-access')).toBe(access);
    expect(within(icon).getByTestId(ICON_TEST_ID[access])).toBeTruthy();
    // Tones come from the shared meta, so a gated option stays amber and the rest do not.
    const color = PUBLISH_ACCESS_META[access].color;
    const style = getComputedStyle(icon);
    const expected = color === 'warning' ? 'var(--joy-palette-warning-700)' : `var(--joy-palette-${color}-softColor)`;
    expect(style.color).toBe(expected);
    expect(style.backgroundColor).toBe(`var(--joy-palette-${color}-softBg)`);
    // Joy icons ignore the inherited color unless --Icon-color points at it.
    expect(style.getPropertyValue('--Icon-color')).toBe('currentColor');
  };

  it.each([
    ['public', 'public'],
    ['organization', 'organization'],
    ['private', 'private'],
  ] as const)('draws the %s visibility option with the badge icon and color', (value, access) => {
    renderModal();
    expectAccessIcon(`publish-share-visibility-${value}-icon`, access);
  });

  it.each([
    ['none', 'public'],
    ['passphrase', 'passphrase'],
    ['domain', 'domain'],
  ] as const)('draws the %s gate option with the badge icon and color', (value, access) => {
    renderModal();
    expectAccessIcon(`publish-share-gate-${value}-icon`, access);
  });

  it('uses the badge chip color for a gated option in dark mode, not the light-mode shade', () => {
    renderModal({}, 'dark');
    expect(getComputedStyle(screen.getByTestId('publish-share-gate-passphrase-icon')).color).toBe(
      'var(--joy-palette-warning-softColor)'
    );
  });

  it('keeps the plain-language titles and does not repeat the badge word beside them', () => {
    renderModal();
    expect(screen.getByTestId('publish-share-visibility-public').textContent).toContain('Anyone with the link');
    expect(screen.getByTestId('publish-share-visibility-public').textContent).not.toContain('Public');
    expect(screen.getByTestId('publish-share-visibility-organization').textContent).toBe(
      'TeamMembers of Acme, and anyone you send a private link to'
    );
    expect(screen.getByTestId('publish-share-visibility-private').textContent).toBe(
      `Private${PUBLISH_ACCESS_META.private.description}`
    );
    expect(radio('public')?.checked).toBe(true);
    expect(radio('none')?.checked).toBe(true);
  });

  it('keeps the public exposure copy, in the Public treatment rather than amber', () => {
    renderModal();
    const note = screen.getByTestId('publish-share-public-note');
    expect(note.textContent).toContain('Anyone with the link can view this.');
    expect(within(note).getByTestId('PublicIcon')).toBeTruthy();
  });

  const liveResult = (visibility: PublishVisibility): PublishResult => ({
    publicId: 'live-1',
    url: '/p/u/u1/s',
    tier: 'user',
    scopeId: 'u1',
    slug: 's',
    visibility,
    publishedAt: '2026-01-01T00:00:00.000Z',
  });

  /** Publish at `visibility` onto a record holding `accessGate` and a live private link. */
  const renderSharedWithLink = async (visibility: PublishVisibility, accessGate: unknown = null) => {
    (api.get as unknown as ReturnType<typeof vi.fn>).mockReset().mockImplementation((url: string) =>
      Promise.resolve({
        data: url.endsWith('/share-token') ? { shareToken: 'TOK', shareLinks: [] } : { artifact: { accessGate } },
      })
    );
    apiPatch.mockClear().mockResolvedValue({ data: {} });
    renderModal({ defaultVisibility: visibility, publish: vi.fn().mockResolvedValue(liveResult(visibility)) });
    fireEvent.click(screen.getByTestId('publish-share-create'));
    return screen.findByTestId('publish-share-token-warning');
  };

  it('draws the private-link exposure line in the Public treatment when no gate is stored', async () => {
    const warning = await renderSharedWithLink('private');
    expect(warning.textContent).toBe('Anyone with this link can view without signing in.');
    expect(warning.getAttribute('data-access')).toBe('public');
    expect(within(warning).getByTestId('PublicIcon')).toBeTruthy();
    expect(screen.getByTestId('publish-share-token-label').textContent).toBe(
      'Private link anyone can open, no sign-in'
    );
    expect(screen.getByTestId('publish-share-token-hint').textContent).toContain('without signing in');
  });

  // The server enforces a stored gate on /a/<token> links at every visibility (checkShareGrant).
  it.each([
    ['passphrase', { kind: 'passphrase' }, 'KeyIcon', 'who also has the passphrase'],
    [
      'domain',
      { kind: 'domain', allowedDomains: ['example.com'] },
      'DomainIcon',
      'who signs in with a verified email from an allowed domain',
    ],
  ] as const)(
    'says a private link also needs the stored %s gate, in the gated treatment',
    async (kind, gate, icon, who) => {
      await renderSharedWithLink('private', gate);
      const warning = screen.getByTestId('publish-share-token-warning');
      await waitFor(() => expect(warning.getAttribute('data-access')).toBe(kind));
      expect(warning.textContent).toBe(`Anyone with this link ${who} can view.`);
      expect(within(warning).getByTestId(icon)).toBeTruthy();
      // The theme's light warning text is about 1.4:1 on its soft background; the badge's darker shade is used.
      expect(getComputedStyle(warning).color).toBe('var(--joy-palette-warning-700)');
      const hint = screen.getByTestId('publish-share-token-hint').textContent;
      expect(hint).toContain(`This one opens for anyone you send it to ${who}.`);
      expect(hint).not.toContain('without signing in');
      expect(screen.getByTestId('publish-share-token-label').textContent).toBe('Private link');
    }
  );

  it('switches the private-link note to the gate once one is applied live', async () => {
    const warning = await renderSharedWithLink('public');
    expect(warning.getAttribute('data-access')).toBe('public');
    fireEvent.click(radio('passphrase')!);
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByTestId('publish-share-gate-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('publish-share-token-warning').getAttribute('data-access')).toBe('passphrase')
    );
    expect(screen.getByTestId('publish-share-token-hint').textContent).toContain(
      'already opens for anyone who also has the passphrase.'
    );
  });

  it('returns the private-link note to the open treatment, and offers the embed editor again, once the gate is cleared live', async () => {
    await renderSharedWithLink('public', { kind: 'passphrase' });
    await waitFor(() =>
      expect(screen.getByTestId('publish-share-token-warning').getAttribute('data-access')).toBe('passphrase')
    );
    expect(screen.queryByTestId('publish-share-embed-section')).toBeNull();
    fireEvent.click(radio('none')!);
    fireEvent.click(screen.getByTestId('publish-share-gate-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('publish-share-token-warning').getAttribute('data-access')).toBe('public')
    );
    expect(screen.getByTestId('publish-share-token-warning').textContent).toBe(
      'Anyone with this link can view without signing in.'
    );
    expect(screen.getByTestId('publish-share-embed-section')).toBeTruthy();
  });

  it('labels the create-link button for a gated page', async () => {
    (api.get as unknown as ReturnType<typeof vi.fn>).mockReset().mockImplementation((url: string) =>
      Promise.resolve({
        data: url.endsWith('/share-token')
          ? { shareToken: null, shareLinks: [] }
          : { artifact: { accessGate: { kind: 'passphrase' } } },
      })
    );
    renderModal({ defaultVisibility: 'private', publish: vi.fn().mockResolvedValue(liveResult('private')) });
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await waitFor(() =>
      expect(screen.getByTestId('publish-share-token-create').textContent).toBe('Create private link')
    );
  });
});

describe('PublishShareModal - a refused publish shows the server reason', () => {
  const refusal = (status: number, data: Record<string, unknown>) => {
    const error = new AxiosError('Request failed');
    error.response = { status, data } as AxiosError['response'];
    return error;
  };

  afterEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  it.each([
    {
      status: 429,
      data: {
        error: "You've published a lot today. Try again in 42 minutes.",
        code: 'publish_rate_limited',
        retryAfter: 2520,
      },
    },
    { status: 413, data: { error: 'Publish storage quota reached', code: 'quota_bytes_exceeded' } },
  ])('toasts the $status message rather than a generic failure', async ({ status, data }) => {
    const publish = vi.fn().mockRejectedValue(refusal(status, data));
    render(
      <Wrapper>
        <PublishShareModal open onClose={() => {}} publish={publish} title="My artifact" defaultVisibility="private" />
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('publish-share-create'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(data.error));
    expect(screen.queryByTestId('publish-share-url')).toBeNull();
  });
});

/**
 * A gate stored on a private or team page is enforced only on its private links, and the server
 * refuses to revoke the last link while it stands. The dialog shows that gate and offers the same
 * confirmed Clear as the Live Artifacts sharing panel, so a refused Revoke has a way forward.
 */
describe('PublishShareModal - clearing a gate stored on a non-public page', () => {
  const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
  const REFUSAL = "This share link is the only thing enforcing the artifact's access gate - clear it first";
  const orphanRefusal = () =>
    Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      response: { status: 400, data: { error: REFUSAL, code: 'REVOKE_WOULD_ORPHAN_GATE' } },
    });
  const publication = (visibility: PublishVisibility): PublishResult => ({
    publicId: 'pub-1',
    url: '/p/u/u1/s',
    tier: visibility === 'organization' ? 'organization' : 'user',
    scopeId: 'u1',
    slug: 's',
    visibility,
    publishedAt: '2026-01-01T00:00:00.000Z',
  });

  /** A record that behaves like the server: Revoke is refused while a gate is stored, a null PATCH clears it. */
  const fakeServer = (
    visibility: PublishVisibility,
    initialGate: unknown,
    { seedFails = false }: { seedFails?: boolean } = {}
  ) => {
    const record = { gate: initialGate, link: 'TOK' as string | null };
    let recordReads = 0;
    apiGet.mockReset().mockImplementation((url: string) => {
      if (url.endsWith('/share-token')) return Promise.resolve({ data: { shareToken: record.link, shareLinks: [] } });
      recordReads += 1;
      if (seedFails && recordReads === 1) return Promise.reject(new Error('Record unavailable'));
      return Promise.resolve({ data: { artifact: { visibility, accessGate: record.gate } } });
    });
    apiPatch.mockReset().mockImplementation((_url: string, body: { accessGate?: unknown }) => {
      if (body.accessGate === null) record.gate = null;
      return Promise.resolve({ data: {} });
    });
    apiDelete.mockReset().mockImplementation(() => {
      if (record.gate) return Promise.reject(orphanRefusal());
      record.link = null;
      return Promise.resolve({ data: {} });
    });
    apiPost.mockReset().mockResolvedValue({ data: {} });
    return record;
  };

  const renderOpen = (
    visibility: PublishVisibility,
    props: Partial<React.ComponentProps<typeof PublishShareModal>> = {}
  ) =>
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={vi.fn().mockResolvedValue(publication(visibility))}
          title="My artifact"
          defaultVisibility={visibility}
          orgOption={{ label: 'Team', hint: 'Members of Acme' }}
          {...props}
        />
      </Wrapper>
    );

  /** Publish at `visibility`, then wait for the private link to be on screen. */
  const renderShared = async (visibility: PublishVisibility = 'private') => {
    renderOpen(visibility);
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-token-url');
  };

  const clickClear = () => fireEvent.click(screen.getByTestId('publish-share-gate-clear'));
  const confirmClear = () => fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));
  const gateWrites = () => apiPatch.mock.calls.filter(([, body]) => 'accessGate' in (body ?? {}));

  let invalidate: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  });
  afterEach(() => {
    invalidate.mockRestore();
  });

  it.each([
    ['private', 'The page itself, not a private link, still opens only for you.'],
    ['organization', 'Team members who open the page itself, not a private link, are not asked for it.'],
  ] as const)(
    'shows the stored gate and a Clear action on a %s page, before any revoke',
    async (visibility, sentence) => {
      fakeServer(visibility, { kind: 'passphrase' });
      await renderShared(visibility);

      const note = await screen.findByTestId('publish-share-stored-gate');
      expect(note.textContent).toContain('Passphrase gate');
      expect(note.textContent).toContain('Private links to this page need the passphrase.');
      expect(note.textContent).toContain(sentence);
      expect(screen.getByTestId('publish-share-stored-gate-revoke-note').textContent).toContain('cleared');
      expect(screen.getByTestId('publish-share-gate-clear')).toBeTruthy();
      expect(apiDelete).not.toHaveBeenCalled();
    }
  );

  it('shows a stored domain gate with the domain wording', async () => {
    fakeServer('private', { kind: 'domain', allowedDomains: ['example.com'] });
    await renderShared();

    const note = await screen.findByTestId('publish-share-stored-gate');
    expect(note.textContent).toContain('Email domain gate');
    expect(note.textContent).toContain('Private links to this page need a verified email from an allowed domain.');
  });

  it('offers no Clear action when no gate is stored', async () => {
    fakeServer('private', null);
    await renderShared();

    await waitFor(() => expect(screen.getByTestId('publish-share-token-label').textContent).toContain('no sign-in'));
    expect(screen.queryByTestId('publish-share-stored-gate')).toBeNull();
    expect(screen.queryByTestId('publish-share-gate-clear')).toBeNull();
  });

  it('offers no Clear action on a public page, where the gate editor is already on screen', async () => {
    fakeServer('public', { kind: 'passphrase' });
    await renderShared('public');

    await waitFor(() =>
      expect(screen.getByTestId('publish-share-token-warning').getAttribute('data-access')).toBe('passphrase')
    );
    expect(screen.queryByTestId('publish-share-stored-gate')).toBeNull();
    expect(screen.queryByTestId('publish-share-gate-clear')).toBeNull();
  });

  it('refused revoke -> clear offered -> clear -> the retried revoke succeeds', async () => {
    fakeServer('private', { kind: 'passphrase' });
    await renderShared();
    await screen.findByTestId('publish-share-stored-gate');
    expect(screen.getByTestId('publish-share-token-label').textContent).toBe('Private link');

    fireEvent.click(screen.getByTestId('publish-share-token-revoke'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REFUSAL));
    expect(screen.getByTestId('publish-share-token-url')).toBeTruthy();
    expect(screen.getByTestId('publish-share-gate-clear')).toBeTruthy();

    screen.getByTestId('publish-share-gate-clear').focus();
    clickClear();
    // Asks first: nothing is written until the owner confirms.
    expect(screen.getByTestId('confirmation-dialog')).toBeTruthy();
    expect(gateWrites()).toHaveLength(0);
    confirmClear();

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { accessGate: null }));
    await waitFor(() => expect(screen.queryByTestId('publish-share-stored-gate')).toBeNull());
    expect(screen.queryByTestId('confirmation-dialog')).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('Gate cleared - private links no longer ask for it');

    // The gated copy gives way to the ungated state.
    expect(screen.getByTestId('publish-share-token-label').textContent).toBe(
      'Private link anyone can open, no sign-in'
    );
    expect(screen.getByTestId('publish-share-token-hint').textContent).not.toContain('passphrase');
    const warning = screen.getByTestId('publish-share-token-warning');
    expect(warning.textContent).toBe('Anyone with this link can view without signing in.');
    expect(warning.getAttribute('data-access')).toBe('public');
    expect(screen.getByTestId('publish-share-visibility-private').textContent).not.toContain('passphrase');

    // The Live Artifacts row badge is refreshed by a list refetch.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['published-artifacts', 'mine'] });
    // The Clear button is gone, so focus lands on the action the owner was after.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('publish-share-token-revoke')));

    fireEvent.click(screen.getByTestId('publish-share-token-revoke'));
    await waitFor(() => expect(screen.queryByTestId('publish-share-token-url')).toBeNull());
    expect(screen.getByTestId('publish-share-token-create')).toBeTruthy();
    expect(apiDelete).toHaveBeenCalledTimes(2);
  });

  it('keeps the gate and the refusal in place when the clear fails, and says why', async () => {
    fakeServer('private', { kind: 'domain', allowedDomains: ['example.com'] });
    await renderShared();
    await screen.findByTestId('publish-share-stored-gate');
    apiPatch.mockReset().mockRejectedValue(new Error('Network down'));

    clickClear();
    confirmClear();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Network down'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirmation-dialog')).toBeNull();
    expect(screen.getByTestId('publish-share-stored-gate')).toBeTruthy();
    expect(screen.getByTestId('publish-share-token-label').textContent).toBe('Private link');
    expect(screen.getByTestId('publish-share-token-warning').getAttribute('data-access')).toBe('domain');
    expect(invalidate).not.toHaveBeenCalled();

    // Still refused, and still clearable.
    fireEvent.click(screen.getByTestId('publish-share-token-revoke'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REFUSAL));
    expect(screen.getByTestId('publish-share-token-url')).toBeTruthy();
    expect((screen.getByTestId('publish-share-gate-clear') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends nothing when the owner cancels the confirmation', async () => {
    fakeServer('private', { kind: 'passphrase' });
    await renderShared();
    await screen.findByTestId('publish-share-stored-gate');

    clickClear();
    fireEvent.click(screen.getByTestId('confirmation-cancel-btn'));

    expect(screen.queryByTestId('confirmation-dialog')).toBeNull();
    expect(gateWrites()).toHaveLength(0);
    expect(screen.getByTestId('publish-share-stored-gate')).toBeTruthy();
  });

  it('learns the stored gate from a refused revoke when the first record read failed', async () => {
    fakeServer('private', { kind: 'passphrase' }, { seedFails: true });
    await renderShared();
    // The seed read failed, so the dialog cannot say what is stored and has nothing to clear yet.
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(screen.queryByTestId('publish-share-stored-gate')).toBeNull();

    fireEvent.click(screen.getByTestId('publish-share-token-revoke'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REFUSAL));
    const note = await screen.findByTestId('publish-share-stored-gate');
    expect(note.textContent).toContain('Passphrase gate');
    clickClear();
    expect(screen.getByTestId('confirmation-dialog').textContent).toContain('cannot be recovered');
  });

  it('does not re-read the record after a failure that was not the gate refusal', async () => {
    fakeServer('private', { kind: 'passphrase' });
    await renderShared();
    await screen.findByTestId('publish-share-stored-gate');
    const recordReads = () => apiGet.mock.calls.filter(([url]) => String(url).endsWith('/pub-1')).length;
    const before = recordReads();
    apiDelete.mockReset().mockRejectedValue(new Error('Network down'));

    fireEvent.click(screen.getByTestId('publish-share-token-revoke'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Network down'));
    expect(recordReads()).toBe(before);
  });

  it('starts the Access choice open after a clear, not on the gate it was seeded from', async () => {
    fakeServer('private', { kind: 'passphrase' });
    renderOpen('private', { resolvePublished: () => Promise.resolve(publication('private')) });
    await screen.findByTestId('publish-share-stored-gate');

    clickClear();
    confirmClear();
    await waitFor(() => expect(screen.queryByTestId('publish-share-stored-gate')).toBeNull());
    fireEvent.click(screen.getByTestId('publish-share-visibility-public'));

    await screen.findByTestId('publish-share-gate');
    expect(radio('none')?.checked).toBe(true);
    expect(radio('passphrase')?.checked).toBe(false);
    expect(screen.queryByTestId('publish-share-gate-apply')).toBeNull();
  });

  // The confirmation is the editor's own, so what the owner reads before clearing cannot drift apart.
  it.each([
    ['passphrase', { kind: 'passphrase' }],
    ['domain', { kind: 'domain', allowedDomains: ['example.com'] }],
  ] as const)('shows the same %s gate note and confirmation as the sharing panel editor', async (_kind, gate) => {
    render(
      <Wrapper>
        <AccessGateEditor publicId="pub-1" visibility="private" initialGate={gate} />
      </Wrapper>
    );
    const editorNote = screen.getByTestId('manage-gate-private-link-note').textContent;
    fireEvent.click(screen.getByTestId('manage-gate-clear'));
    const editorDialog = screen.getByTestId('confirmation-dialog').textContent;
    expect(editorDialog).toContain('Clear access gate');
    cleanup();

    fakeServer('private', gate);
    await renderShared();
    const modalNote = await screen.findByTestId('publish-share-stored-gate');
    expect(modalNote.textContent).toContain(editorNote);
    clickClear();

    expect(screen.getByTestId('confirmation-dialog').textContent).toBe(editorDialog);
  });

  it('sends one clear when the confirm button is pressed twice', async () => {
    fakeServer('private', { kind: 'passphrase' });
    await renderShared();
    await screen.findByTestId('publish-share-stored-gate');
    let finishWrite: () => void = () => {};
    apiPatch.mockReset().mockImplementation(
      () =>
        new Promise(resolve => {
          finishWrite = () => resolve({ data: {} });
        })
    );

    clickClear();
    confirmClear();
    confirmClear();
    await act(async () => finishWrite());

    await waitFor(() => expect(screen.queryByTestId('publish-share-stored-gate')).toBeNull());
    expect(gateWrites()).toHaveLength(1);
  });

  it('keeps a clear that landed while the record was being re-read after a refusal', async () => {
    fakeServer('private', { kind: 'passphrase' });
    await renderShared();
    await screen.findByTestId('publish-share-stored-gate');
    // The re-read a refusal starts stays out until after the clear, then answers with the old gate.
    let answerRead: () => void = () => {};
    const getShareToken = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((url: string) =>
      url.endsWith('/share-token')
        ? getShareToken(url)
        : new Promise(resolve => {
            answerRead = () =>
              resolve({ data: { artifact: { visibility: 'private', accessGate: { kind: 'passphrase' } } } });
          })
    );

    fireEvent.click(screen.getByTestId('publish-share-token-revoke'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REFUSAL));
    clickClear();
    confirmClear();
    await waitFor(() => expect(screen.queryByTestId('publish-share-stored-gate')).toBeNull());

    await act(async () => answerRead());
    expect(screen.queryByTestId('publish-share-stored-gate')).toBeNull();
    expect(screen.getByTestId('publish-share-token-label').textContent).toBe(
      'Private link anyone can open, no sign-in'
    );
  });
});

/** A shared non-public option's hint is two sentences: who the page is for, then what its private links need. */
describe('PublishShareModal - non-public option hints once shared', () => {
  const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
  const PRIVATE = 'Only you, and anyone you send a private link to';
  const TEAM = 'Members of Acme, and anyone you send a private link to';
  const PASSPHRASE = 'Private links open only for viewers who also have the passphrase.';
  const DOMAIN = 'Private links open only for viewers who sign in with a verified email from an allowed domain.';
  const UNKNOWN = 'Private-link access depends on its access settings.';
  beforeEach(() => vi.mocked(toast.warning).mockClear());

  const renderSharedWith = async (visibility: PublishVisibility, gate: unknown, { seedFails = false } = {}) => {
    apiGet.mockReset().mockImplementation((url: string) => {
      if (url.endsWith('/share-token')) return Promise.resolve({ data: { shareToken: null, shareLinks: [] } });
      if (seedFails) return Promise.reject(new Error('Record unavailable'));
      return Promise.resolve({ data: { artifact: { visibility, accessGate: gate } } });
    });
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={vi.fn().mockResolvedValue({
            publicId: 'pub-1',
            url: '/p/u/u1/s',
            tier: visibility === 'organization' ? 'organization' : 'user',
            scopeId: 'u1',
            slug: 's',
            visibility,
            publishedAt: '2026-01-01T00:00:00.000Z',
          })}
          title="My artifact"
          defaultVisibility={visibility}
          orgOption={{ label: 'Team', hint: 'Members of Acme' }}
        />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-token-create');
  };
  const hint = (value: string) => screen.getByTestId(`publish-share-visibility-${value}-hint`).textContent;

  it.each([
    ['passphrase', { kind: 'passphrase' }, PASSPHRASE],
    ['domain', { kind: 'domain', allowedDomains: ['example.com'] }, DOMAIN],
  ] as const)('ends the Private and Team hints before naming the stored %s gate', async (_kind, gate, sentence) => {
    await renderSharedWith('organization', gate);
    await waitFor(() => expect(hint('private')).toBe(`${PRIVATE}. ${sentence}`));
    expect(hint('organization')).toBe(`${TEAM}. ${sentence}`);
    expect(hint('public')).toBe('Anyone you send the link to can view it');
  });

  it('ends the Private hint before saying a record that could not be read leaves access unknown', async () => {
    await renderSharedWith('private', null, { seedFails: true });
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(hint('private')).toBe(`${PRIVATE}. ${UNKNOWN}`);
  });

  it('adds nothing to the Private hint when no gate is stored', async () => {
    await renderSharedWith('private', null);
    await waitFor(() =>
      expect(screen.getByTestId('publish-share-token-create').textContent).toContain('anyone can open')
    );
    expect(hint('private')).toBe(PRIVATE);
  });
});

describe('PublishShareModal - helper text contrast', () => {
  /** Helper text is dimmed by a theme text token, never `opacity`, which stacks on the token and drops it below AA. */
  const expectTokenDimmed = (el: HTMLElement, token: 'secondary' | 'tertiary') => {
    const style = getComputedStyle(el);
    expect(['', '1']).toContain(style.opacity);
    expect(style.color).toContain(`--joy-palette-text-${token}`);
  };

  const renderModal = (props: Partial<React.ComponentProps<typeof PublishShareModal>> = {}) =>
    render(
      <Wrapper>
        <PublishShareModal
          open
          onClose={() => {}}
          publish={noopPublish}
          title="My artifact"
          defaultVisibility="public"
          {...props}
        />
      </Wrapper>
    );

  it('dims the intro, option hints and toggle explanations with a text token, not opacity', async () => {
    renderModal({
      resolveExisting: () =>
        Promise.resolve({
          title: 'My artifact',
          versionsCount: 2,
          slug: 's',
          visibility: 'public',
          commentPolicy: 'open',
        }),
    });
    await screen.findByTestId('publish-share-mode-update');

    expectTokenDimmed(screen.getByTestId('publish-share-intro'), 'secondary');
    expectTokenDimmed(screen.getByText(/Currently 2 versions/), 'tertiary');
    expectTokenDimmed(screen.getByTestId('publish-share-gate-preserved'), 'tertiary');
    expectTokenDimmed(
      within(screen.getByTestId('publish-share-visibility-public')).getByText(/Anyone you send the link to/),
      'tertiary'
    );
    expectTokenDimmed(screen.getByText('Viewers just open the link'), 'tertiary');
    expectTokenDimmed(
      within(screen.getByTestId('publish-share-discoverable-text')).getByText(/Off by default/),
      'tertiary'
    );
    expectTokenDimmed(screen.getByText(/Viewers can leave feedback/), 'tertiary');

    fireEvent.click(radio('passphrase')!);
    expectTokenDimmed(screen.getByText(/Share it however you like/), 'tertiary');
    fireEvent.click(radio('domain')!);
    expectTokenDimmed(screen.getByText(/Viewers sign in \(or sign up free\)/), 'tertiary');
  });

  it('dims the shared-phase intro and private-link hint with a text token, not opacity', async () => {
    (api.get as unknown as ReturnType<typeof vi.fn>).mockReset().mockImplementation((url: string) =>
      Promise.resolve({
        data: url.endsWith('/share-token') ? { shareToken: 'TOK', shareLinks: [] } : { artifact: { accessGate: null } },
      })
    );
    renderModal({
      defaultVisibility: 'private',
      publish: vi.fn().mockResolvedValue({
        publicId: 'live-1',
        url: '/p/u/u1/s',
        tier: 'user',
        scopeId: 'u1',
        slug: 's',
        visibility: 'private',
        publishedAt: '2026-01-01T00:00:00.000Z',
      }),
    });
    fireEvent.click(screen.getByTestId('publish-share-create'));
    const hint = await screen.findByTestId('publish-share-token-hint');

    expectTokenDimmed(hint, 'tertiary');
    expectTokenDimmed(screen.getByTestId('publish-share-intro'), 'secondary');
  });
});

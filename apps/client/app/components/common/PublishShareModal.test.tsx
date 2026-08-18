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

  it('offers Team but not Private in the shared phase after an org-tier publish', async () => {
    // org-tier record: 'private' is not a valid override (SCOPE_POLICY), so it must not be a
    // dead-end option; Team/Public are the valid live changes.
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
    expect(radio('private')).toBeNull();
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
    visibility: 'public',
    publishedAt: '2026-01-01T00:00:00.000Z',
  };

  const renderShared = async () => {
    apiPost.mockClear().mockResolvedValue({ data: { shareToken: 'TOK', shareUrl: '/a/TOK' } });
    apiDelete.mockClear().mockResolvedValue({ data: {} });
    const publish = vi.fn().mockResolvedValue(publishResult);
    render(
      <Wrapper>
        <PublishShareModal open onClose={() => {}} publish={publish} title="My artifact" defaultVisibility="public" />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('publish-share-create'));
    await screen.findByTestId('publish-share-url'); // shared phase
  };

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

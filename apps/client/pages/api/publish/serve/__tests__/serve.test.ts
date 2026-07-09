import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockArtifactFindOne, mockProjectFindOne, mockDownload } = vi.hoisted(() => ({
  mockArtifactFindOne: vi.fn(),
  mockProjectFindOne: vi.fn(),
  mockDownload: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method; .use() no-op; last fn per verb is handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

// Optional-auth shims: pass through (anonymous). Tests set req.user directly when needed.
vi.mock('@server/middlewares/apiKeyAuth', () => ({
  apiKeyAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/optionalJwtAuth', () => ({
  optionalJwtAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('@server/utils/storage', () => ({
  getPublishedArtifactsStorage: () => ({ download: mockDownload }),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: (...a: unknown[]) => ({ lean: () => Promise.resolve(mockArtifactFindOne(...a)) }),
    updateOne: () => Promise.resolve(),
  },
  Project: {
    findOne: (...a: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(mockProjectFindOne(...a)) }) }),
  },
}));

import handler from '../[...path]';

// SERVER_DOMAIN is set in the test env, so Approach B is ON: an app-host bundle
// request returns a WRAPPER embedding a cross-origin iframe to {publicId}.usercontent.app.<domain>;
// the bundle CONTENT is served in isolated mode (`uc`), reached via the /uc rewrite (__uc=1) on
// that usercontent host. `uc` = the publicId whose isolated origin we're simulating.
type RunOpts = { user?: unknown; host?: string; raw?: boolean; v?: string; uc?: string; format?: string };
const run = (segments: string[], { user, host = 'app.bike4mind.com', raw, v, uc, format }: RunOpts = {}) => {
  const query: Record<string, unknown> = { path: segments };
  if (raw) query.raw = '1';
  if (v) query.v = v;
  if (format) query.format = format;
  const effectiveHost = uc ? `${uc}.usercontent.app.bike4mind.com` : host;
  if (uc) query.__uc = '1';
  const { req, res } = createMocks({ method: 'GET', query, headers: { host: effectiveHost } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const bundle = (over: Record<string, unknown> = {}) => ({
  publicId: 'pub1',
  tier: 'user',
  scopeId: 'scope123',
  slug: 'my-slug',
  title: 'My Artifact',
  visibility: 'public',
  ownerId: 'owner1',
  storageKeyPrefix: 'user/scope123/my-slug/',
  manifest: [{ path: 'index.html', mimeType: 'text/html' }],
  source: { kind: 'bundle' },
  ...over,
});

beforeEach(() => {
  mockArtifactFindOne.mockReset();
  mockProjectFindOne.mockReset().mockResolvedValue(null);
  mockDownload.mockReset();
});

describe('GET /api/publish/serve — sandboxed bundle', () => {
  it('app host returns a wrapper embedding the CROSS-ORIGIN isolated iframe (Approach B)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(
      Buffer.from(`<html><head></head><body><h1>Hi</h1><script>console.log(42)</script></body></html>`)
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    // Bundle is embedded from its own isolated origin, NOT inlined into the app origin.
    expect(data).toContain('src="https://pub1.usercontent.app.bike4mind.com/uc/u/scope123/my-slug"');
    expect(data).not.toContain('srcdoc=');
    expect(data).not.toContain('console.log(42)'); // author JS lives on the isolated origin
    // Minimal sandbox: allow-scripts + allow-same-origin only (no forms/popups).
    expect(data).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(data).not.toContain('allow-forms');
    expect(data).not.toContain('allow-popups');
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("frame-src 'self' https://pub1.usercontent.app.bike4mind.com"); // can embed it
    // Wrapper has no inline scripts / bundle libs in Approach B -> tightened script-src.
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).toContain('/api/publish/widget'); // only the external overlay widget
  });

  it('falls back to the same-origin srcdoc when the wrapper is NOT served from an app host', async () => {
    // shared-dev serves the app at files.dev.<domain> with no *.usercontent.app alias, so the
    // cross-origin embed would 403 - self-gate to Approach A srcdoc instead.
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(
      Buffer.from('<html><head></head><body><script>console.log(42)</script></body></html>')
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { host: 'files.dev.bike4mind.com' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('srcdoc='); // Approach A fallback
    expect(data).toContain('console.log(42)'); // bundle inlined into the srcdoc
    expect(data).not.toContain('usercontent.app.bike4mind.com'); // no cross-origin embed attempted
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("script-src 'unsafe-inline'"); // srcdoc inherits → must permit bundle inline JS
  });

  it('isolated origin serves the bundle AS the page with inline JS + unsafe-inline CSP', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(
      Buffer.from(`<html><head></head><body><h1>Hi</h1><script>console.log(42)</script></body></html>`)
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { uc: 'pub1' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('console.log(42)'); // author inline JS runs on the isolated origin
    expect(data).toContain('<base href='); // public tier <base> → assets stay on the isolated origin
    expect(data).not.toContain('<iframe'); // it IS the page, not a wrapper
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("script-src 'unsafe-inline'"); // inline allowed — isolation is the origin, not stripping
    // frame-ancestors is the EXACT app wrapper host, no wildcard. Since usercontent
    // origins are nested under `.app.<domain>`, a `*.app.<domain>` source would suffix-match
    // them and re-permit bundle-on-bundle framing - so assert the wildcard is absent and that
    // a concrete usercontent host is not an allowed ancestor.
    const frameAncestors = csp
      .split(';')
      .find(d => d.trim().startsWith('frame-ancestors'))!
      .trim();
    expect(frameAncestors).toBe('frame-ancestors https://app.bike4mind.com');
    expect(frameAncestors).not.toContain('*'); // no wildcard → cannot match any *.app subdomain
    expect(frameAncestors).not.toContain('usercontent'); // one bundle can't frame another
  });

  it('isolated request 404s when the host publicId does not match the artifact', async () => {
    mockArtifactFindOne.mockReturnValue(bundle()); // publicId pub1
    mockDownload.mockResolvedValue(Buffer.from('<html><body>x</body></html>'));
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { uc: 'someoneelse' });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('inlines assets for a gated bundle (no credentialed request from the opaque origin)', async () => {
    mockArtifactFindOne.mockReturnValue(
      bundle({
        visibility: 'private',
        ownerId: 'owner1',
        manifest: [
          { path: 'index.html', mimeType: 'text/html' },
          { path: 'logo.png', mimeType: 'image/png' },
        ],
      })
    );
    mockDownload.mockImplementation((key: string) =>
      Promise.resolve(
        key.endsWith('index.html')
          ? Buffer.from(`<html><body><img src="logo.png"></body></html>`)
          : Buffer.from('PNGBYTES')
      )
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { user: { id: 'owner1' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain(`data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`);
    expect(data).not.toContain('<base'); // gated tier does NOT inject <base>
    expect(data).not.toContain('allow-same-origin');
    // Negative case: nothing dropped -> no dropped-asset headers at all.
    expect(res.getHeader('X-Publish-Dropped-Assets')).toBeUndefined();
    expect(res.getHeader('X-Publish-Dropped-Asset-Names')).toBeUndefined();
  });

  it('returns the loader shell (not 401) for an anonymous viewer of a gated bundle index', async () => {
    // Previously this was a hard 401; a gated bundle INDEX with no credential now returns the
    // public client-side loader shell (the gate still short-circuits before storage). The
    // hard-401/403 paths (assets, ?raw=1, authed-non-member) are covered below.
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'private', ownerId: 'owner1' }));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('<iframe id="b4m-frame"');
    expect(mockDownload).not.toHaveBeenCalled(); // shell carries no secret, no storage read
  });

  it('drops an oversized gated asset and reports it via header (no silent truncation)', async () => {
    mockArtifactFindOne.mockReturnValue(
      bundle({
        visibility: 'private',
        ownerId: 'owner1',
        manifest: [
          { path: 'index.html', mimeType: 'text/html' },
          { path: 'huge.png', mimeType: 'image/png' },
        ],
      })
    );
    const huge = Buffer.alloc(3 * 1024 * 1024 + 1); // > PER_ASSET_MAX_BYTES
    mockDownload.mockImplementation((key: string) =>
      Promise.resolve(key.endsWith('index.html') ? Buffer.from(`<html><body><img src="huge.png"></body></html>`) : huge)
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { user: { id: 'owner1' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Publish-Dropped-Assets')).toBe('1');
    expect(res.getHeader('X-Publish-Dropped-Asset-Names')).toContain('huge.png');
    const data = res._getData() as string;
    expect(data).not.toContain('data:image/png;base64,'); // huge asset was not inlined
  });

  it('admin views any gated bundle', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'private', ownerId: 'someone-else' }));
    mockDownload.mockResolvedValue(Buffer.from(`<html><body>ok</body></html>`));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { user: { id: 'admin1', isAdmin: true } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
  });

  it('returns 403 for a project-tier bundle when the viewer is not a project member', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'project', scopeId: 'proj1', ownerId: 'someone-else' }));
    mockProjectFindOne.mockResolvedValue(null); // not a member

    const { res, promise } = run(['pj', 'proj1', 'my-slug'], { user: { id: 'outsider' } });
    await promise;

    expect(res._getStatusCode()).toBe(403);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('HTML-escapes the bundle title in the wrapper page (no breakout)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ title: 'Tom & Jerry "<script>alert(1)</script>"' }));
    mockDownload.mockResolvedValue(Buffer.from(`<html><body>ok</body></html>`));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    const data = res._getData() as string;
    // escapeHtml neutralizes the title in both <title> and the iframe title attribute.
    expect(data).toContain('&lt;script&gt;');
    expect(data).toContain('Tom &amp; Jerry');
    expect(data).not.toContain('<title>Tom & Jerry "<script>');
  });

  it('falls back to the app host when the Host header is not allowlisted', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from(`<html><body>ok</body></html>`));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { host: 'attacker.com' });
    await promise;

    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).not.toContain('attacker.com'); // crafted Host never reaches the CSP
    expect(csp).toContain('https://app.bike4mind.com'); // pinned to the app host
  });
});

describe('GET /api/publish/serve — gated-bundle loader shell', () => {
  it('returns a public loader shell (not 401) for a gated bundle index with no credential', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'private', ownerId: 'owner1' }));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/html; charset=utf-8');
    const data = res._getData() as string;
    expect(data).toContain('<iframe id="b4m-frame" sandbox="allow-scripts"');
    expect(data).not.toContain('allow-same-origin');
    expect(data).toContain("localStorage.getItem('access-token-storage')");
    expect(data).toContain("'raw=1'");
    // CSP permits the shell's inline bootstrap + the same-origin ?raw=1 fetch.
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain('connect-src https://app.bike4mind.com');
    // Shell carries no secret - no index download happens.
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('does NOT return the shell for a gated ASSET request with no credential (stays 401)', async () => {
    mockArtifactFindOne.mockReturnValue(
      bundle({
        visibility: 'private',
        ownerId: 'owner1',
        manifest: [
          { path: 'index.html', mimeType: 'text/html' },
          { path: 'logo.png', mimeType: 'image/png' },
        ],
      })
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug', 'logo.png']);
    await promise;

    expect(res._getStatusCode()).toBe(401);
    const data = res._getData() as string;
    expect(data).not.toContain('<iframe');
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('does NOT return the shell for a 403 (authed but not authorized)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'project', scopeId: 'proj1', ownerId: 'someone-else' }));
    mockProjectFindOne.mockResolvedValue(null);

    const { res, promise } = run(['pj', 'proj1', 'my-slug'], { user: { id: 'outsider' } });
    await promise;

    expect(res._getStatusCode()).toBe(403);
    expect(res._getData() as string).not.toContain('<iframe id="b4m-frame"');
  });

  it('still serves a public bundle directly (shell gate does not fire for public)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from(`<html><body>ok</body></html>`));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('src="https://pub1.usercontent.app.bike4mind.com/uc/'); // the real wrapper (Approach B)
    expect(data).not.toContain('b4m-frame'); // loader-shell marker absent
  });
});

describe('GET /api/publish/serve — ?raw=1 authenticated render mode', () => {
  it('returns the inner srcdoc as inert text/plain for an authorized gated bundle', async () => {
    mockArtifactFindOne.mockReturnValue(
      bundle({
        visibility: 'private',
        ownerId: 'owner1',
        manifest: [
          { path: 'index.html', mimeType: 'text/html' },
          { path: 'logo.png', mimeType: 'image/png' },
        ],
      })
    );
    mockDownload.mockImplementation((key: string) =>
      Promise.resolve(
        key.endsWith('index.html')
          ? Buffer.from(`<html><body><img src="logo.png"><script>console.log(7)</script></body></html>`)
          : Buffer.from('PNGBYTES')
      )
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { user: { id: 'owner1' }, raw: true });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(res.getHeader('X-Content-Type-Options')).toBe('nosniff');
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res.getHeader('Content-Security-Policy')).toContain('sandbox');
    const data = res._getData() as string;
    expect(data).not.toContain('<iframe'); // raw is the INNER srcdoc, not the wrapper
    expect(data).toContain('console.log(7)'); // author inline JS preserved
    expect(data).toContain(`data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`);
  });

  it('returns 401 (never a shell) for ?raw=1 on a gated bundle with no credential', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'private', ownerId: 'owner1' }));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { raw: true });
    await promise;

    expect(res._getStatusCode()).toBe(401);
    const data = res._getData() as string;
    expect(data).not.toContain('<iframe'); // loop-breaker: no shell on raw
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('returns 403 (never a shell) for ?raw=1 when authed but not a project member', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'project', scopeId: 'proj1', ownerId: 'someone-else' }));
    mockProjectFindOne.mockResolvedValue(null);

    const { res, promise } = run(['pj', 'proj1', 'my-slug'], { user: { id: 'outsider' }, raw: true });
    await promise;

    expect(res._getStatusCode()).toBe(403);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('serves a public bundle in raw mode with the public-tier <base>', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from(`<html><head></head><body>ok</body></html>`));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { raw: true });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/plain; charset=utf-8');
    const data = res._getData() as string;
    expect(data).toContain('<base href=');
    expect(data).not.toContain('<iframe');
  });
});

describe('GET /api/publish/serve — reply/fabfile path is unchanged', () => {
  it('renders a public reply with script-src none (not the iframe path)', async () => {
    mockArtifactFindOne.mockReturnValue({
      publicId: 'r1',
      title: 'A reply',
      visibility: 'public',
      ownerId: 'owner1',
      source: { kind: 'reply' },
      renderedBody: '# Hello world',
      storageKeyPrefix: '',
      manifest: [],
      tier: 'user',
      scopeId: 's',
      slug: 'x',
    });

    const { res, promise } = run(['r', 'r1']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('Hello world');
    expect(data).not.toContain('<iframe'); // reply path does not use the sandbox iframe
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("script-src 'none'");
  });
});

describe('GET /api/publish/serve — version history (?v)', () => {
  const versioned = (over: Record<string, unknown> = {}) =>
    bundle({ sha256Index: 'curSHA', versions: [{ sha256Index: 'oldSHA' }, { sha256Index: 'curSHA' }], ...over });
  const dl = (key: string) =>
    Promise.resolve(
      Buffer.from(
        key.includes('versions/oldSHA.html') ? '<html><body>OLD</body></html>' : '<html><body>CURRENT</body></html>'
      )
    );

  it('app wrapper shows the switcher + points the iframe at the isolated origin for a known ?v', async () => {
    mockArtifactFindOne.mockReturnValue(versioned());
    mockDownload.mockImplementation(dl);
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { v: 'oldSHA' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('src="https://pub1.usercontent.app.bike4mind.com/uc/u/scope123/my-slug?v=oldSHA"'); // ?v forwarded to the isolated origin
    expect(data).toContain('class="b4m-ver"'); // version switcher rendered
    expect(data).toContain('of 2'); // "v1 of 2"
    // Cold-path historical view is no-store so it can't poison the canonical
    // cache entry on a CDN policy that doesn't key on ?v.
    expect(res.getHeader('Cache-Control')).toContain('no-store');
  });

  it('isolated origin serves the archived index for a known ?v', async () => {
    mockArtifactFindOne.mockReturnValue(versioned());
    mockDownload.mockImplementation(dl);
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { v: 'oldSHA', uc: 'pub1' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('OLD'); // historical index served from versions/oldSHA.html
    expect(res.getHeader('Cache-Control')).toContain('no-store');
  });

  it('ignores an UNKNOWN ?v and serves current (no arbitrary archive read)', async () => {
    mockArtifactFindOne.mockReturnValue(versioned());
    mockDownload.mockImplementation(dl);
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { v: 'evilSHA', uc: 'pub1' });
    await promise;
    const data = res._getData() as string;
    expect(data).toContain('CURRENT'); // fell back to index.html, not versions/evilSHA.html
    // ensure we never tried to read the attacker-supplied archive key
    expect(mockDownload.mock.calls.some((c: unknown[]) => String(c[0]).includes('versions/evilSHA'))).toBe(false);
  });

  it('shows no switcher for a single-version artifact', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ sha256Index: 'curSHA', versions: [{ sha256Index: 'curSHA' }] }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body>only</body></html>'));
    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;
    expect(res._getData() as string).not.toContain('class="b4m-ver"');
  });
});

describe('GET /api/publish/serve - public share agent readability', () => {
  it('injects og:*, twitter:*, description, canonical, and a link rel="alternate" on the public wrapper', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ description: 'A concise summary.' }));
    mockDownload.mockResolvedValue(
      Buffer.from('<html><head></head><body><p>Article body text for the noscript excerpt.</p></body></html>')
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('<meta name="description" content="A concise summary.">');
    expect(data).toContain('<meta property="og:title" content="My Artifact">');
    expect(data).toContain('<meta property="og:description" content="A concise summary.">');
    expect(data).toContain('<meta property="og:type" content="article">');
    expect(data).toContain('<meta property="og:url" content="https://app.bike4mind.com/p/u/scope123/my-slug">');
    expect(data).toContain('<meta name="twitter:card" content="summary">');
    expect(data).toContain('<link rel="canonical" href="https://app.bike4mind.com/p/u/scope123/my-slug">');
    expect(data).toContain(
      '<link rel="alternate" type="text/plain" href="https://app.bike4mind.com/p/u/scope123/my-slug?format=raw"'
    );
    // noscript body carries a title + the extracted body text (no author HTML) for non-JS clients.
    expect(data).toContain('<noscript>');
    expect(data).toContain('Article body text for the noscript excerpt.');
  });

  it('falls back to a body-derived description when the artifact has no description', async () => {
    mockArtifactFindOne.mockReturnValue(bundle()); // no description
    mockDownload.mockResolvedValue(Buffer.from('<html><body><p>Body-derived summary text.</p></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain('<meta property="og:description" content="Body-derived summary text.">');
  });

  it('does NOT emit agent-readable meta or noscript for a gated share (loader shell must stay blank)', async () => {
    // No credential -> gated bundle returns the loader shell. The shell must not leak the
    // artifact title/description; a request that DID have a credential goes through the
    // wrapper path but is still non-public, so we also assert no og:description leaks there.
    mockArtifactFindOne.mockReturnValue(
      bundle({ visibility: 'private', ownerId: 'owner1', description: 'secret summary' })
    );
    mockDownload.mockResolvedValue(Buffer.from('<html><body>ok</body></html>'));

    // Anonymous -> loader shell.
    const anon = run(['u', 'scope123', 'my-slug']);
    await anon.promise;
    const anonBody = anon.res._getData() as string;
    expect(anonBody).not.toContain('secret summary');
    expect(anonBody).not.toContain('og:description');
    expect(anonBody).not.toContain('link rel="alternate"');

    // Authorized owner -> wrapper. Still no agent-readable meta (gated shares aren't
    // an agent surface); the loader shell path is the only public disclosure surface.
    const owner = run(['u', 'scope123', 'my-slug'], { user: { id: 'owner1' } });
    await owner.promise;
    const ownerBody = owner.res._getData() as string;
    expect(ownerBody).not.toContain('og:description');
    expect(ownerBody).not.toContain('link rel="alternate"');
  });
});

describe('GET /api/publish/serve - ?format=raw plain-text alternate', () => {
  it('serves a public bundle as text/plain with title + description + body excerpt', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ description: 'A summary.' }));
    mockDownload.mockResolvedValue(
      Buffer.from(
        '<html><head><style>.a{}</style></head><body><script>evil()</script><h1>Ignore</h1><p>The article body.</p></body></html>'
      )
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { format: 'raw' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(res.getHeader('X-Content-Type-Options')).toBe('nosniff');
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
    const body = res._getData() as string;
    expect(body).toContain('# My Artifact');
    expect(body).toContain('A summary.');
    expect(body).toContain('The article body.');
    // Script/style contents were stripped, not surfaced as text.
    expect(body).not.toContain('evil()');
    expect(body).not.toContain('.a{}');
  });

  it('serves a public reply as text/plain with renderedBody', async () => {
    mockArtifactFindOne.mockReturnValue({
      publicId: 'r1',
      title: 'A reply',
      visibility: 'public',
      ownerId: 'owner1',
      source: { kind: 'reply' },
      renderedBody: '# Hello world\n\nBody markdown.',
      storageKeyPrefix: '',
      manifest: [],
      tier: 'user',
      scopeId: 's',
      slug: 'x',
    });

    const { res, promise } = run(['r', 'r1'], { format: 'raw' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/plain; charset=utf-8');
    const body = res._getData() as string;
    expect(body).toContain('# A reply');
    expect(body).toContain('# Hello world');
    expect(body).toContain('Body markdown.');
  });

  it('returns 404 for ?format=raw on a private bundle (never a raw leak of gated content)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'private', ownerId: 'owner1' }));

    // Even the owner (who could otherwise view it) gets 404 - format=raw is a public surface only.
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { format: 'raw', user: { id: 'owner1' } });
    await promise;
    expect(res._getStatusCode()).toBe(404);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('does NOT return the loader shell for anonymous ?format=raw on a private bundle', async () => {
    // The loader shell is a UI surface; ?format=raw is a text/plain API surface. An anonymous
    // caller asking for the raw variant of a private artifact should get the visibility gate's
    // hard status (401), not an HTML shell that violates the Accept contract. Also ensures we
    // never accidentally set up a code path where the shell could carry artifact bytes.
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'private', ownerId: 'owner1' }));
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { format: 'raw' });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    const body = res._getData() as string;
    expect(body).not.toContain('<iframe');
    expect(body).not.toContain('<html');
  });

  it('returns 404 for ?format=raw on a private reply', async () => {
    mockArtifactFindOne.mockReturnValue({
      publicId: 'r1',
      title: 'private reply',
      visibility: 'private',
      ownerId: 'owner1',
      source: { kind: 'reply' },
      renderedBody: 'secret',
      storageKeyPrefix: '',
      manifest: [],
      tier: 'user',
      scopeId: 's',
      slug: 'x',
    });

    const { res, promise } = run(['r', 'r1'], { format: 'raw', user: { id: 'owner1' } });
    await promise;
    expect(res._getStatusCode()).toBe(404);
    const body = res._getData() as string;
    expect(body).not.toContain('secret');
  });
});

describe('GET /api/publish/serve — comment pin bridge', () => {
  const BRIDGE_MARKER = 'pin-dropped'; // distinctive to the injected pin-bridge script
  const WIDGET_MOUNT = 'b4m-annotate-root'; // the wrapper comment-overlay mount node

  it('app wrapper carries the trusted overlay; the bridge lives on the isolated origin', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ commentPolicy: 'open' }));
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain(WIDGET_MOUNT); // trusted overlay injected into the wrapper (app origin)
    expect(data).toContain('/api/publish/widget');
    // The bridge rides INSIDE the bundle, which now lives on the isolated origin - not the wrapper.
    expect(data).not.toContain(BRIDGE_MARKER);
  });

  it('injects the pin bridge into the isolated-origin bundle when comments are enabled', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ commentPolicy: 'open' }));
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { uc: 'pub1' });
    await promise;

    const data = res._getData() as string;
    expect(data).toContain(BRIDGE_MARKER); // bridge injected into the isolated bundle document
    expect(data).not.toContain(WIDGET_MOUNT); // the trusted overlay never crosses into the isolated origin
  });

  it('injects NO bridge or overlay when comments are disabled (default)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle()); // no commentPolicy → 'none'
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    const data = res._getData() as string;
    expect(data).not.toContain(BRIDGE_MARKER);
    expect(data).not.toContain(WIDGET_MOUNT);
  });

  it('injects the bridge into the ?raw=1 srcdoc too (loader-shell path)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ commentPolicy: 'open' }));
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { raw: true });
    await promise;

    expect(res._getData() as string).toContain(BRIDGE_MARKER);
  });
});

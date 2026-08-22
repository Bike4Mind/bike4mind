import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockArtifactFindOne, mockProjectFindOne, mockDownload, mockUpdateOne, mockUserFindById } = vi.hoisted(() => ({
  mockArtifactFindOne: vi.fn(),
  mockProjectFindOne: vi.fn(),
  mockDownload: vi.fn(),
  mockUpdateOne: vi.fn(() => Promise.resolve()),
  // Domain access gates look the viewer's verified email up through User (checkVisibility).
  mockUserFindById: vi.fn(),
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
// Rate limiter: pass-through so share-branch requests proceed. rateLimit itself is unit-tested.
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('@server/utils/storage', () => ({
  getPublishedArtifactsStorage: () => ({ download: mockDownload }),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: (...a: unknown[]) => ({ lean: () => Promise.resolve(mockArtifactFindOne(...a)) }),
    updateOne: (...a: unknown[]) => mockUpdateOne(...a),
  },
  Project: {
    findOne: (...a: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(mockProjectFindOne(...a)) }) }),
  },
  User: {
    findById: (...a: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(mockUserFindById(...a)) }) }),
  },
}));

import handler from '../[...path]';

// SERVER_DOMAIN is set in the test env, so Approach B is ON: an app-host bundle
// request returns a WRAPPER embedding a cross-origin iframe to {publicId}.usercontent.app.<domain>;
// the bundle CONTENT is served in isolated mode (`uc`), reached via the /uc rewrite (__uc=1) on
// that usercontent host. `uc` = the publicId whose isolated origin we're simulating.
type RunOpts = {
  user?: unknown;
  host?: string;
  raw?: boolean;
  v?: string;
  uc?: string;
  format?: string;
  cookie?: string;
  userAgent?: string;
  embed?: boolean;
  a?: string;
  exportAs?: unknown;
};
const run = (
  segments: string[],
  { user, host = 'app.bike4mind.com', raw, v, uc, format, cookie, userAgent, embed, a, exportAs }: RunOpts = {}
) => {
  const query: Record<string, unknown> = { path: segments };
  if (raw) query.raw = '1';
  if (v) query.v = v;
  if (format) query.format = format;
  if (embed) query.embed = '1';
  if (a !== undefined) query.a = a;
  if (exportAs !== undefined) query.export = exportAs;
  const effectiveHost = uc ? `${uc}.usercontent.app.bike4mind.com` : host;
  if (uc) query.__uc = '1';
  const headers: Record<string, string> = { host: effectiveHost };
  if (cookie) headers.cookie = cookie;
  if (userAgent) headers['user-agent'] = userAgent;
  const { req, res } = createMocks({ method: 'GET', query, headers });
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
  mockUpdateOne.mockReset().mockResolvedValue(undefined);
  mockUserFindById.mockReset().mockResolvedValue(null);
});

describe('GET /api/publish/serve - sandboxed bundle', () => {
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
    expect(data).not.toContain("b4m:'hash'"); // no inline hash bridge - the CSP would block it
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
    expect(csp).toContain("script-src 'unsafe-inline'"); // srcdoc inherits -> must permit bundle inline JS
    expect(data).toContain("b4m:'hash'"); // srcdoc mode carries the wrapper hash bridge
    expect(data).toContain("b4m:'fragment'"); // and the srcdoc carries the fragment-nav helper
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
    expect(data).toContain('<base href='); // public tier <base> -> assets stay on the isolated origin
    expect(data).not.toContain('<iframe'); // it IS the page, not a wrapper
    // Fragment-nav helper knows BOTH the /uc alias it is served at and the canonical /p path.
    expect(data).toContain('"paths":["/uc/u/scope123/my-slug","/p/u/scope123/my-slug"]');
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("script-src 'unsafe-inline'"); // inline allowed - isolation is the origin, not stripping
    // frame-ancestors is the EXACT app wrapper host, no wildcard. Since usercontent
    // origins are nested under `.app.<domain>`, a `*.app.<domain>` source would suffix-match
    // them and re-permit bundle-on-bundle framing - so assert the wildcard is absent and that
    // a concrete usercontent host is not an allowed ancestor.
    const frameAncestors = csp
      .split(';')
      .find(d => d.trim().startsWith('frame-ancestors'))!
      .trim();
    expect(frameAncestors).toBe('frame-ancestors https://app.bike4mind.com');
    expect(frameAncestors).not.toContain('*'); // no wildcard -> cannot match any *.app subdomain
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

describe('GET /api/publish/serve - gated-bundle loader shell', () => {
  it('returns a public loader shell (not 401) for a gated bundle index with no credential', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'private', ownerId: 'owner1' }));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/html; charset=utf-8');
    const data = res._getData() as string;
    expect(data).toContain('<iframe id="b4m-frame" sandbox="allow-scripts"');
    expect(data).not.toContain('allow-same-origin');
    expect(data).toContain("fetch('/api/auth/refreshToken'");
    expect(data).toContain("'raw=1'");
    // CSP permits the shell's inline bootstrap + the same-origin refresh/?raw=1 fetches.
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain('connect-src https://app.bike4mind.com');
    expect(data).toContain("b4m:'hash'"); // hash bridge feeds deep links into the injected srcdoc
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

describe('GET /api/publish/serve - ?raw=1 authenticated render mode', () => {
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

describe('GET /api/publish/serve - reply/fabfile path is unchanged', () => {
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

describe('GET /api/publish/serve - reply embedded HTML artifact (#708)', () => {
  const HTML_ARTIFACT =
    '<artifact identifier="tip" type="text/html" title="Tip Calculator">' +
    '<!DOCTYPE html><html><head><title>Tip</title></head>' +
    '<body><label>Bill</label><input><script>window.ok=1</script></body></html>' +
    '</artifact>';

  const htmlReply = (over: Record<string, unknown> = {}) => ({
    publicId: 'rhtml',
    // Simulates the #708 title bug on an EXISTING row: the reply led with the artifact, so
    // deriveTitle snapshotted the raw wrapper tag as the title.
    title: '<artifact identifier="tip" type="text/html" title="Tip Calculator">',
    visibility: 'public',
    ownerId: 'owner1',
    source: { kind: 'reply' },
    renderedBody: HTML_ARTIFACT,
    storageKeyPrefix: '',
    manifest: [],
    tier: 'user',
    scopeId: 's',
    slug: 'rhtml',
    ...over,
  });

  it('renders the reply page with a sandboxed iframe pointing at the ?a= sub-document, not raw markup', async () => {
    mockArtifactFindOne.mockReturnValue(htmlReply());
    const { res, promise } = run(['r', 'rhtml']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('sandbox="allow-scripts"');
    expect(data).toContain('src="/p/r/rhtml?a=0"');
    // The artifact's inner markup must NOT leak into the reply page as text.
    expect(data).not.toContain('<label>Bill</label>');
    // Page itself stays script-free; the frame is permitted via frame-src.
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-src 'self'");
  });

  it('recovers a sensible <title> when the stored title is the raw <artifact> tag', async () => {
    mockArtifactFindOne.mockReturnValue(htmlReply());
    const { res, promise } = run(['r', 'rhtml']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain('<title>Tip Calculator</title>');
    expect(data).not.toContain('<title>&lt;artifact');
  });

  it('serves the ?a= sub-document as a sandboxed HTML doc that runs the artifact JS in isolation', async () => {
    mockArtifactFindOne.mockReturnValue(htmlReply());
    const { res, promise } = run(['r', 'rhtml'], { a: '0' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toContain('text/html');
    const data = res._getData() as string;
    expect(data).toContain('window.ok=1'); // author script preserved (runs in the sandbox)
    expect(data).toContain('Bill');
    const csp = res.getHeader('Content-Security-Policy') as string;
    // Opaque origin even on direct nav; author inline JS allowed only inside the sandbox.
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'none'");
  });

  it('404s an out-of-range ?a= index', async () => {
    mockArtifactFindOne.mockReturnValue(htmlReply());
    const { res, promise } = run(['r', 'rhtml'], { a: '7' });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('renders a placeholder card (no iframe) for a non-embeddable artifact type, and 404s its ?a=', async () => {
    const reactReply = htmlReply({
      publicId: 'rreact',
      slug: 'rreact',
      title: 'React demo',
      renderedBody:
        '<artifact identifier="c" type="application/vnd.ant.react" title="Counter">export default function C(){return null}</artifact>',
    });
    mockArtifactFindOne.mockReturnValue(reactReply);

    const { res: pageRes, promise: pagePromise } = run(['r', 'rreact']);
    await pagePromise;
    const page = pageRes._getData() as string;
    expect(page).toContain('b4m-artifact-card');
    expect(page).not.toContain('<iframe');

    const { res: subRes, promise: subPromise } = run(['r', 'rreact'], { a: '0' });
    await subPromise;
    expect(subRes._getStatusCode()).toBe(404);
  });

  it('renders a placeholder card (not a frame) for a Bearer-gated org reply, since the iframe could not authorize', async () => {
    // An org-visibility reply authorizes off req.user (Bearer). An artifact iframe navigation
    // cannot send that header, so framing would dead-end at a nested loader shell - render the
    // card instead. (Public + share + passphrase-cookie cases still frame; covered elsewhere.)
    const gated = htmlReply({
      publicId: 'r-org-html',
      slug: 'r-org-html',
      visibility: 'organization',
      tier: 'organization',
      scopeId: 'org_42',
    });
    mockArtifactFindOne.mockReturnValue(gated);
    const { res, promise } = run(['r', 'r-org-html'], { user: { id: 'member', organizationId: 'org_42' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('b4m-artifact-card');
    expect(data).not.toContain('<iframe');
  });

  it('frames the artifact on a /a/{token} share, pointing the iframe back at the token path', async () => {
    mockArtifactFindOne.mockReturnValue(htmlReply({ publicId: 'r-shared', slug: 'r-shared' }));

    const { res: pageRes, promise: pagePromise } = run(['a', 'tokshare']);
    await pagePromise;
    expect(pageRes._getStatusCode()).toBe(200);
    const page = pageRes._getData() as string;
    expect(page).toContain('src="/a/tokshare?a=0"');

    const { res: subRes, promise: subPromise } = run(['a', 'tokshare'], { a: '0' });
    await subPromise;
    expect(subRes._getStatusCode()).toBe(200);
    expect(subRes._getData() as string).toContain('window.ok=1');
  });

  it('serves an embedded SVG artifact sub-document with its markup (viewBox case preserved)', async () => {
    const svgReply = htmlReply({
      publicId: 'rsvg',
      slug: 'rsvg',
      title: 'A drawing',
      renderedBody:
        '<artifact identifier="s" type="image/svg+xml" title="Circle">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>' +
        '</artifact>',
    });
    mockArtifactFindOne.mockReturnValue(svgReply);

    const { res: pageRes, promise: pagePromise } = run(['r', 'rsvg']);
    await pagePromise;
    expect(pageRes._getData() as string).toContain('src="/p/r/rsvg?a=0"');

    const { res: subRes, promise: subPromise } = run(['r', 'rsvg'], { a: '0' });
    await subPromise;
    expect(subRes._getStatusCode()).toBe(200);
    const svg = subRes._getData() as string;
    expect(svg).toContain('<circle');
    // camelCase SVG attributes must survive the cheerio round-trip, or the SVG renders broken.
    expect(svg).toContain('viewBox');
  });

  it('maps ?a=0 and ?a=1 to the correct artifact when a reply embeds two HTML artifacts', async () => {
    const twoReply = htmlReply({
      publicId: 'r2',
      slug: 'r2',
      title: 'Two artifacts',
      renderedBody:
        '<artifact type="text/html" title="First"><body><h1>FIRST_ARTIFACT</h1></body></artifact>\n' +
        '<artifact type="text/html" title="Second"><body><h1>SECOND_ARTIFACT</h1></body></artifact>',
    });
    mockArtifactFindOne.mockReturnValue(twoReply);

    const { res: pageRes, promise: pagePromise } = run(['r', 'r2']);
    await pagePromise;
    const page = pageRes._getData() as string;
    expect(page).toContain('src="/p/r/r2?a=0"');
    expect(page).toContain('src="/p/r/r2?a=1"');

    // Artifacts render in DOCUMENT order (extractViewerArtifacts sorts by startIndex), and the
    // viewer + handler share that ordering, so ?a=0 is the first artifact and ?a=1 the second.
    const { res: a0, promise: p0 } = run(['r', 'r2'], { a: '0' });
    await p0;
    const doc0 = a0._getData() as string;
    expect(doc0).toContain('FIRST_ARTIFACT');
    expect(doc0).not.toContain('SECOND_ARTIFACT');

    const { res: a1, promise: p1 } = run(['r', 'r2'], { a: '1' });
    await p1;
    const doc1 = a1._getData() as string;
    expect(doc1).toContain('SECOND_ARTIFACT');
    expect(doc1).not.toContain('FIRST_ARTIFACT');
  });

  it('treats an empty ?a= as the normal page render, not artifact index 0', async () => {
    mockArtifactFindOne.mockReturnValue(htmlReply());
    const { res, promise } = run(['r', 'rhtml'], { a: '' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    // Fell through to the page (which frames artifact 0), rather than serving artifact 0's srcdoc.
    expect(res._getData() as string).toContain('src="/p/r/rhtml?a=0"');
  });
});

describe('GET /api/publish/serve - fabfile embedded HTML artifact (#722)', () => {
  // A fabfile is literal file text (kept as escaped <pre>), but an embedded <artifact> block frames
  // via the same sandboxed ?a= path as the reply viewer. The leading text uses markdown syntax to
  // prove the fabfile branch does NOT marked-render it.
  const FAB_BODY =
    '# My File\n' +
    '<artifact identifier="w" type="text/html" title="Widget">' +
    '<!DOCTYPE html><html><body><h1>FAB_WIDGET</h1><script>window.fab=1</script></body></html>' +
    '</artifact>';

  const htmlFab = (over: Record<string, unknown> = {}) => ({
    publicId: 'fhtml',
    title: 'notes.md',
    visibility: 'public',
    ownerId: 'owner1',
    source: { kind: 'fabfile' },
    renderedBody: FAB_BODY,
    storageKeyPrefix: '',
    manifest: [],
    tier: 'user',
    scopeId: 's',
    slug: 'fhtml',
    ...over,
  });

  it('frames the embedded artifact and keeps the remaining fabfile text as literal escaped <pre> (not markdown)', async () => {
    mockArtifactFindOne.mockReturnValue(htmlFab());
    const { res, promise } = run(['f', 'fhtml']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('sandbox="allow-scripts"');
    expect(data).toContain('src="/p/f/fhtml?a=0"');
    // Non-artifact text stays literal in a <pre>: the markdown heading is NOT rendered to <h1>.
    expect(data).toContain('<pre class="b4m-pre">');
    expect(data).toContain('# My File');
    expect(data).not.toContain('<h1>My File</h1>');
    // The artifact's inner markup must NOT leak into the page (it lives in the iframe sub-doc).
    expect(data).not.toContain('FAB_WIDGET');
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-src 'self'");
  });

  it('serves the fabfile ?a= sub-document as a sandboxed HTML doc that runs the artifact JS in isolation', async () => {
    mockArtifactFindOne.mockReturnValue(htmlFab());
    const { res, promise } = run(['f', 'fhtml'], { a: '0' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toContain('text/html');
    expect(res._getData() as string).toContain('window.fab=1');
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain("script-src 'none'");
  });

  it('404s an out-of-range fabfile ?a= index', async () => {
    mockArtifactFindOne.mockReturnValue(htmlFab());
    const { res, promise } = run(['f', 'fhtml'], { a: '7' });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('renders a placeholder card (no iframe) for a non-embeddable fabfile artifact type, and 404s its ?a=', async () => {
    const reactFab = htmlFab({
      publicId: 'freact',
      slug: 'freact',
      renderedBody:
        '<artifact identifier="c" type="application/vnd.ant.react" title="Counter">export default function C(){return null}</artifact>',
    });
    mockArtifactFindOne.mockReturnValue(reactFab);

    const { res: pageRes, promise: pagePromise } = run(['f', 'freact']);
    await pagePromise;
    const page = pageRes._getData() as string;
    expect(page).toContain('b4m-artifact-card');
    expect(page).not.toContain('<iframe');

    const { res: subRes, promise: subPromise } = run(['f', 'freact'], { a: '0' });
    await subPromise;
    expect(subRes._getStatusCode()).toBe(404);
  });

  it('renders a placeholder card (not a frame) for a Bearer-gated org fabfile', async () => {
    const gated = htmlFab({
      publicId: 'f-org-html',
      slug: 'f-org-html',
      visibility: 'organization',
      tier: 'organization',
      scopeId: 'org_42',
    });
    mockArtifactFindOne.mockReturnValue(gated);
    const { res, promise } = run(['f', 'f-org-html'], { user: { id: 'member', organizationId: 'org_42' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('b4m-artifact-card');
    expect(data).not.toContain('<iframe');
  });

  it('frames the fabfile artifact on a /a/{token} share, pointing the iframe back at the token path', async () => {
    mockArtifactFindOne.mockReturnValue(htmlFab({ publicId: 'f-shared', slug: 'f-shared' }));

    const { res: pageRes, promise: pagePromise } = run(['a', 'ftok']);
    await pagePromise;
    expect(pageRes._getStatusCode()).toBe(200);
    expect(pageRes._getData() as string).toContain('src="/a/ftok?a=0"');

    const { res: subRes, promise: subPromise } = run(['a', 'ftok'], { a: '0' });
    await subPromise;
    expect(subRes._getStatusCode()).toBe(200);
    expect(subRes._getData() as string).toContain('window.fab=1');
  });

  it('renders a plain-text fabfile (no artifact) as an escaped <pre>, unchanged - no iframe', async () => {
    const plain = htmlFab({
      publicId: 'fplain',
      slug: 'fplain',
      renderedBody: 'line one\nif (a < b && c) {}\nline three',
    });
    mockArtifactFindOne.mockReturnValue(plain);
    const { res, promise } = run(['f', 'fplain']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('<pre class="b4m-pre">');
    expect(data).not.toContain('<iframe');
    // Special chars are HTML-escaped, so the literal text is safe and preserved.
    expect(data).toContain('a &lt; b &amp;&amp; c');
  });

  it('keeps a ```-fenced code block in a fabfile VERBATIM in the <pre> (no fence promotion to a card)', async () => {
    // A fabfile is literal file text: a code fence in an uploaded markdown file is content, not an
    // artifact. Fabfiles parse with parseArtifacts (explicit <artifact> only), so - unlike a reply -
    // the fence is NOT hoisted into an "open in the app" card and must stay in the escaped <pre>.
    const fenced = htmlFab({
      publicId: 'ffence',
      slug: 'ffence',
      renderedBody: '# Cheatsheet\n\n```python\nimport numpy as np\ndef go():\n    print("hi")\n```\n',
    });
    mockArtifactFindOne.mockReturnValue(fenced);
    const { res, promise } = run(['f', 'ffence']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('<pre class="b4m-pre">');
    expect(data).not.toContain('<iframe');
    // The card CLASS is always in the page CSS; assert no card ELEMENT was emitted.
    expect(data).not.toContain('<div class="b4m-artifact-card"');
    // The fenced code stays literal in the <pre> (escaped), not extracted into an artifact.
    expect(data).toContain('import numpy as np');
    expect(data).toContain('```python');
  });
});

describe('GET /api/publish/serve - reply/fabfile organization visibility', () => {
  // Org-tier reply/fabfile records store the org id as scopeId; the gate authorizes a viewer
  // whose organizationId matches. This is the path #174 re-enables for reply/fabfile shares.
  const orgReply = (over: Record<string, unknown> = {}) => ({
    publicId: 'r-org',
    title: 'Org reply',
    visibility: 'organization',
    ownerId: 'owner1',
    source: { kind: 'reply' },
    renderedBody: '# Org only',
    storageKeyPrefix: '',
    manifest: [],
    tier: 'organization',
    scopeId: 'org_42',
    slug: 'r-org',
    ...over,
  });

  it('serves an org reply to a same-org member (200)', async () => {
    mockArtifactFindOne.mockReturnValue(orgReply());
    const { res, promise } = run(['r', 'r-org'], { user: { id: 'someone-else', organizationId: 'org_42' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('Org only');
  });

  it('403s an org reply for a viewer in a different org', async () => {
    mockArtifactFindOne.mockReturnValue(orgReply());
    const { res, promise } = run(['r', 'r-org'], { user: { id: 'someone-else', organizationId: 'org_99' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
  });

  it('serves the loader shell (not 401) for an anonymous nav to a gated org reply', async () => {
    // A top-level nav carries no Authorization header; the shell recovers the localStorage
    // JWT and re-fetches ?raw=1 - same path bundles use. See the loader-shell describe below.
    mockArtifactFindOne.mockReturnValue(orgReply());
    const { res, promise } = run(['r', 'r-org']);
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('<iframe id="b4m-frame" sandbox="allow-scripts"');
  });

  it('serves an org fabfile to a same-org member (200)', async () => {
    mockArtifactFindOne.mockReturnValue(
      orgReply({ publicId: 'f-org', source: { kind: 'fabfile' }, renderedBody: 'org file body', slug: 'f-org' })
    );
    const { res, promise } = run(['f', 'f-org'], { user: { id: 'someone-else', organizationId: 'org_42' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('org file body');
  });

  it('403s an org fabfile for a viewer in a different org', async () => {
    mockArtifactFindOne.mockReturnValue(
      orgReply({ publicId: 'f-org', source: { kind: 'fabfile' }, renderedBody: 'org file body', slug: 'f-org' })
    );
    const { res, promise } = run(['f', 'f-org'], { user: { id: 'someone-else', organizationId: 'org_99' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
  });
});

describe('GET /api/publish/serve - gated reply/fabfile loader shell', () => {
  // Gated reply/fabfile pages are top-level navigations that carry no Authorization header, so
  // (like bundles) they get the public loader shell, whose script re-fetches ?raw=1 with the
  // localStorage JWT. This is what makes an org-shared reply/fabfile actually viewable in a
  // browser after being authorized by the gate.
  const gatedReply = (over = {}) => ({
    publicId: 'r-gated',
    title: 'Gated reply',
    visibility: 'organization',
    ownerId: 'owner1',
    source: { kind: 'reply' },
    renderedBody: '# Secret org reply',
    storageKeyPrefix: '',
    manifest: [],
    tier: 'organization',
    scopeId: 'org_42',
    slug: 'r-gated',
    ...over,
  });

  it('returns the loader shell (not 401) for an anonymous nav to a gated reply', async () => {
    mockArtifactFindOne.mockReturnValue(gatedReply());
    const { res, promise } = run(['r', 'r-gated']);
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('<iframe id="b4m-frame" sandbox="allow-scripts"');
    expect(data).not.toContain('allow-same-origin');
    expect(data).toContain("fetch('/api/auth/refreshToken'");
    expect(data).toContain("'raw=1'");
    // Shell must NOT leak the gated reply's content or title.
    expect(data).not.toContain('Secret org reply');
  });

  it('returns the loader shell for an anonymous nav to a gated fabfile', async () => {
    mockArtifactFindOne.mockReturnValue(
      gatedReply({ publicId: 'f-gated', source: { kind: 'fabfile' }, slug: 'f-gated' })
    );
    const { res, promise } = run(['f', 'f-gated']);
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('<iframe id="b4m-frame" sandbox="allow-scripts"');
  });

  it('does NOT return the shell for a gated reply ?raw=1 with no credential (stays 401, no loop)', async () => {
    mockArtifactFindOne.mockReturnValue(gatedReply());
    const { res, promise } = run(['r', 'r-gated'], { raw: true });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(res._getData() as string).not.toContain('b4m-frame');
  });

  it('renders the reply for a gated ?raw=1 fetch from a same-org member (the shell re-fetch)', async () => {
    mockArtifactFindOne.mockReturnValue(gatedReply());
    const { res, promise } = run(['r', 'r-gated'], { raw: true, user: { id: 'member', organizationId: 'org_42' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('Secret org reply');
    // The srcdoc-injected page keeps script-src 'none' via its own CSP meta (the shell's iframe
    // is allow-scripts, so this backstop must ride along in the HTML, not just the HTTP header).
    expect(data).toContain("script-src 'none'");
  });

  it('does NOT return the shell for a gated reply when authed-but-outside-org (stays 403)', async () => {
    mockArtifactFindOne.mockReturnValue(gatedReply());
    const { res, promise } = run(['r', 'r-gated'], { user: { id: 'outsider', organizationId: 'org_99' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
    expect(res._getData() as string).not.toContain('b4m-frame');
  });
});

describe('GET /api/publish/serve - version history (?v)', () => {
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

describe('GET /api/publish/serve - comment pin bridge', () => {
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
    mockArtifactFindOne.mockReturnValue(bundle()); // no commentPolicy -> 'none'
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

describe('GET /api/publish/serve - /a/<shareToken> no-sign-in links', () => {
  it('serves a public bundle via token: same-origin srcdoc + <base> at /a, noindex + no-store', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['a', 'tok123']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    // Same-origin sandbox model - never the cross-origin usercontent embed.
    expect(data).toContain('srcdoc=');
    expect(data).not.toContain('usercontent.app.bike4mind.com');
    // <base> points assets back through the token path so they self-authorize. It lives
    // inside the srcdoc attribute, so its quotes are HTML-escaped in the wrapper.
    expect(data).toContain('<base href=&quot;https://app.bike4mind.com/a/tok123/&quot;>');
    // Always noindex; never the public SEO/raw surface.
    expect(data).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(data).not.toContain('link rel="alternate"');
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
    expect(res.getHeader('Cache-Control')).toContain('no-store');
  });

  it('grants read to a PRIVATE bundle via token (possession is the capability), using <base> not inlining', async () => {
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
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><img src="logo.png"></body></html>'));

    // No credential at all - the token alone authorizes the read.
    const { res, promise } = run(['a', 'tok123']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('<base href=&quot;https://app.bike4mind.com/a/tok123/&quot;>');
    expect(data).not.toContain('data:image/png;base64,'); // share never inlines - assets self-authorize via the token
    expect(data).not.toContain('b4m-frame'); // no loader shell on the share path
  });

  it('404s an unknown/revoked token (never 401/403, no enumeration signal)', async () => {
    mockArtifactFindOne.mockReturnValue(null);

    const { res, promise } = run(['a', 'gone']);
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('serves a bundle asset through the token path with no-store + noindex', async () => {
    mockArtifactFindOne.mockReturnValue(
      bundle({
        manifest: [
          { path: 'index.html', mimeType: 'text/html' },
          { path: 'logo.png', mimeType: 'image/png' },
        ],
      })
    );
    mockDownload.mockResolvedValue(Buffer.from('PNGBYTES'));

    const { res, promise } = run(['a', 'tok123', 'logo.png']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('image/png');
    expect(res.getHeader('Cache-Control')).toContain('no-store');
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('disables ?format=raw on a share link (no plain-text surface)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body>ok</body></html>'));

    const { res, promise } = run(['a', 'tok123'], { format: 'raw' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // Not honored: returns the HTML wrapper, not the text/plain alternate.
    expect(res.getHeader('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('renders a reply via token with the viewer page + noindex meta', async () => {
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

    const { res, promise } = run(['a', 'tokreply']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('Hello world');
    expect(data).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(res.getHeader('Cache-Control')).toContain('no-store');
  });
});

describe('GET /api/publish/serve - access gates (issue #383)', () => {
  const passphraseGated = () => bundle({ accessGate: { kind: 'passphrase' } });

  it('passphrase-gated navigation with no proof returns the PUBLIC prompt shell, uncached', async () => {
    mockArtifactFindOne.mockReturnValue(passphraseGated());

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('passphrase-protected');
    expect(data).toContain('/api/publish/gate/passphrase');
    // Static shell: no artifact data leaks to an anonymous viewer.
    expect(data).not.toContain('My Artifact');
    expect(data).not.toContain('pub1');
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
    // The credential-input page must not be frame-able (clickjacking).
    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("form-action 'self'");
    // Framed fallback: inside a sandboxed iframe the form cannot submit, so the
    // shell script swaps it for open-in-own-tab guidance instead of a dead end.
    expect(data).toContain('window.top !== window.self');
    expect(data).toContain('cannot be unlocked inside an embedded view');
  });

  it('a valid per-artifact proof cookie unlocks the gated bundle - served like a gated (non-public) page', async () => {
    const { signGateToken } = await import('@server/services/publish/publishGateToken');
    mockArtifactFindOne.mockReturnValue(passphraseGated());
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Secret page</h1></body></html>'));

    const token = signGateToken({ publicId: 'pub1' });
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { cookie: `b4m_pg_pub1=${token}` });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // Gated-public must NOT serve like open-public: no CDN caching, no isolated
    // public origin (srcdoc wrapper instead of the usercontent iframe).
    expect(res.getHeader('Cache-Control')).toBe('private, no-store, must-revalidate');
    const data = res._getData() as string;
    expect(data).not.toContain('usercontent.app.bike4mind.com');
    // Same-page # links must scroll in place: an iframe re-navigation would drop the
    // SameSite proof cookie and dead-end at the prompt shell inside the sandbox.
    expect(data).toContain("b4m:'fragment'"); // helper inside the srcdoc
    expect(data).toContain("b4m:'hash'"); // bridge in the wrapper
    expect(data).toContain('&quot;paths&quot;:[&quot;/p/u/scope123/my-slug&quot;]'); // config, srcdoc-attr escaped
  });

  it('a proof for a DIFFERENT artifact does not unlock (re-prompts instead)', async () => {
    const { signGateToken } = await import('@server/services/publish/publishGateToken');
    mockArtifactFindOne.mockReturnValue(passphraseGated());

    const token = signGateToken({ publicId: 'someOtherArtifact' });
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { cookie: `b4m_pg_pub1=${token}` });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('passphrase-protected');
  });

  it('?raw=1 and asset requests hard-fail the passphrase gate (no shell, no loop)', async () => {
    mockArtifactFindOne.mockReturnValue(passphraseGated());

    const raw = run(['u', 'scope123', 'my-slug'], { raw: true });
    await raw.promise;
    expect(raw.res._getStatusCode()).toBe(401);

    mockArtifactFindOne.mockReturnValue(passphraseGated());
    const asset = run(['u', 'scope123', 'my-slug', 'style.css']);
    await asset.promise;
    expect(asset.res._getStatusCode()).toBe(401);
  });

  it('owner bypasses their own passphrase gate without a proof', async () => {
    mockArtifactFindOne.mockReturnValue(passphraseGated());
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Mine</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { user: { id: 'owner1' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).not.toContain('passphrase-protected');
  });

  it('domain-gated anonymous navigation gets the JWT loader shell (sign-in path), not the passphrase prompt', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ accessGate: { kind: 'domain', allowedDomains: ['acme.com'] } }));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).not.toContain('passphrase-protected');
    // The standard gated-bundle loader shell re-fetches ?raw=1 with the viewer's JWT.
    expect(data).toContain('raw=1');
  });
});

describe('GET /api/publish/serve - isolated /uc origin is open-public-only', () => {
  it('404s a __uc request for an artifact that GAINED a gate (stale embed must not render the passphrase shell on *.usercontent)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ accessGate: { kind: 'passphrase' } }));
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body>ok</body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { uc: 'pub1' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(res._getData() as string).not.toContain('passphrase-protected');
  });

  it('still serves an OPEN-public artifact on the isolated origin', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>ok</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { uc: 'pub1' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
  });
});

describe('GET /api/publish/serve - domain-gated share link recovery (no dead-end)', () => {
  it('a domain-gated /a/<token> navigation with no credential serves the loader shell, not a bare 401', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ accessGate: { kind: 'domain', allowedDomains: ['acme.com'] } }));

    const { res, promise } = run(['a', 'tok123']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    // The loader shell re-fetches ?raw=1 with the viewer's Bearer - the domain-gate recovery.
    expect(data).toContain('raw=1');
    expect(res.getHeader('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('honors ?raw=1 on a share link (loader re-fetch returns srcdoc, not the wrapper)', async () => {
    // Open (ungated, Tier-1) share link: checkShareGrant grants, ?raw=1 returns the
    // inner srcdoc as inert text/plain - previously ?raw=1 was ignored for share and
    // returned the HTML wrapper, which is why the loader shell could never recover.
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>ok</h1></body></html>'));

    const { res, promise } = run(['a', 'tok123'], { raw: true });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/plain; charset=utf-8');
  });
});

describe('GET /api/publish/serve - access gates on /a/<shareToken> links', () => {
  it('passphrase-gated share link with no proof returns the prompt shell (token alone is not enough)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ accessGate: { kind: 'passphrase' } }));

    const { res, promise } = run(['a', 'tok123']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('passphrase-protected');
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
  });

  it('passphrase-gated share link WITH proof serves, inlining assets (proof cookie cannot ride opaque-origin fetches)', async () => {
    const { signGateToken } = await import('@server/services/publish/publishGateToken');
    mockArtifactFindOne.mockReturnValue(
      bundle({
        accessGate: { kind: 'passphrase' },
        manifest: [
          { path: 'index.html', mimeType: 'text/html' },
          { path: 'logo.png', mimeType: 'image/png' },
        ],
      })
    );
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><img src="logo.png"></body></html>'));

    const token = signGateToken({ publicId: 'pub1' });
    const { res, promise } = run(['a', 'tok123'], { cookie: `b4m_pg_pub1=${token}` });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    // Gated share: inline asset model, NOT the <base> self-authorizing model.
    expect(data).not.toContain('<base href=&quot;https://app.bike4mind.com/a/tok123/&quot;>');
    expect(res.getHeader('Cache-Control')).toBe('private, no-store, must-revalidate');
  });

  it('share asset requests hard-fail the passphrase gate (no prompt shell on assets)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ accessGate: { kind: 'passphrase' } }));

    const { res, promise } = run(['a', 'tok123', 'style.css']);
    await promise;
    expect(res._getStatusCode()).toBe(401);
  });
});

describe('GET /api/publish/serve - external view counting (Published gear feed)', () => {
  const renderedReply = () => bundle({ source: { kind: 'reply' }, renderedBody: 'hi there' });

  it('an AUTHENTICATED non-owner view increments externalViewCount', async () => {
    mockArtifactFindOne.mockReturnValue(renderedReply());
    const { promise } = run(['r', 'pub1'], { user: { id: 'someone-else' } });
    await promise;
    expect(mockUpdateOne).toHaveBeenCalledWith({ publicId: 'pub1' }, { $inc: { viewCount: 1, externalViewCount: 1 } });
  });

  it('an ANONYMOUS view does NOT count as external - the serve route cannot tell the owner from a stranger without a credential (self-grant bypass)', async () => {
    mockArtifactFindOne.mockReturnValue(renderedReply());
    const { promise } = run(['r', 'pub1'], { userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1' });
    await promise;
    expect(mockUpdateOne).toHaveBeenCalledWith({ publicId: 'pub1' }, { $inc: { viewCount: 1 } });
  });

  it('a link-preview crawler does NOT count as a visitor', async () => {
    mockArtifactFindOne.mockReturnValue(renderedReply());
    const { promise } = run(['r', 'pub1'], {
      user: { id: 'someone-else' },
      userAgent: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    });
    await promise;
    expect(mockUpdateOne).toHaveBeenCalledWith({ publicId: 'pub1' }, { $inc: { viewCount: 1 } });
  });

  it('the signed-in OWNER does not count as an external view', async () => {
    mockArtifactFindOne.mockReturnValue(renderedReply());
    const { promise } = run(['r', 'pub1'], { user: { id: 'owner1' } });
    await promise;
    expect(mockUpdateOne).toHaveBeenCalledWith({ publicId: 'pub1' }, { $inc: { viewCount: 1 } });
  });
});

describe('GET /api/publish/serve - embed allowlist', () => {
  const frameAncestorsOf = (res: { getHeader: (n: string) => unknown }) =>
    (res.getHeader('Content-Security-Policy') as string)
      .split(';')
      .find(d => d.trim().startsWith('frame-ancestors'))!
      .trim();

  it('appends an allowlisted origin to the WRAPPER frame-ancestors (open-public)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ embedOrigins: ['https://erikbethke.com'] }));
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(frameAncestorsOf(res)).toBe("frame-ancestors 'self' https://app.bike4mind.com https://erikbethke.com");
  });

  it('appends the origin to the ISOLATED bundle frame-ancestors too (ancestor-chain rule)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ embedOrigins: ['https://erikbethke.com'] }));
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { uc: 'pub1' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const fa = frameAncestorsOf(res);
    // The external embedder is an ancestor of the nested bundle, so it must be listed
    // here as well as on the wrapper - but the app host stays and no wildcard appears.
    expect(fa).toBe('frame-ancestors https://app.bike4mind.com https://erikbethke.com');
    expect(fa).not.toContain('*');
  });

  it('adds nothing to frame-ancestors when there is no allowlist (regression)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(frameAncestorsOf(res)).toBe("frame-ancestors 'self' https://app.bike4mind.com");
  });

  it('does NOT honor an allowlist on a gated artifact (loader shell CSP omits the origin)', async () => {
    // A domain gate serves the anonymous loader shell; its CSP must never carry the
    // embed grant (defense in depth - a gated page is no-store and must not be framed).
    mockArtifactFindOne.mockReturnValue(
      bundle({
        accessGate: { kind: 'domain', allowedDomains: ['milliononmars.com'] },
        embedOrigins: ['https://erikbethke.com'],
      })
    );
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    const csp = res.getHeader('Content-Security-Policy') as string;
    expect(csp).not.toContain('erikbethke.com');
  });

  it('?embed=1 renders chrome-less (no version bar) but keeps exactly one canonical link', async () => {
    mockArtifactFindOne.mockReturnValue(
      bundle({
        embedOrigins: ['https://erikbethke.com'],
        sha256Index: 'newSHA',
        versions: [{ sha256Index: 'oldSHA' }, { sha256Index: 'newSHA' }],
      })
    );
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { embed: true });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    // The version-switcher ELEMENT is dropped (its CSS class always lives in <style>).
    expect(data).not.toContain('<div class="b4m-ver">');
    // Canonical is emitted once by shareMeta (not duplicated by the embed path).
    expect(data.match(/rel="canonical"/g)?.length).toBe(1);
    expect(data).toContain('href="https://app.bike4mind.com/p/u/scope123/my-slug"');
    // Lead-gen livery: the embed carries a "Built with ..." brand pill linking out,
    // and NOT the persistent bottom bar (that's the own-tab treatment).
    expect(data).toContain('<a class="b4m-brand"');
    expect(data).toContain('Built with');
    expect(data).not.toContain('<div class="b4m-bar">');
  });

  it('own-tab (non-embed) open-public render shows the persistent lead-gen bar with an in-bar Report', async () => {
    mockArtifactFindOne.mockReturnValue(
      bundle({ sha256Index: 'newSHA', versions: [{ sha256Index: 'oldSHA' }, { sha256Index: 'newSHA' }] })
    );
    mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;
    const data = res._getData() as string;
    // The persistent bar (Anthropic-style) with a Try CTA; the floating pill is embed-only.
    expect(data).toContain('<div class="b4m-bar">');
    expect(data).toContain('class="b4m-bar-cta"');
    expect(data).toContain('Try');
    expect(data).not.toContain('<a class="b4m-brand"');
    // Report moves INTO the bar, so the floating Report anchor is gone.
    expect(data).toContain('class="b4m-bar-report"');
    expect(data).not.toContain('<a class="b4m-report"');
    // Chrome still present (version switcher), lifted above the bar.
    expect(data).toContain('<div class="b4m-ver">');
    // Fork default (no NEXT_PUBLIC_SHARE_BUILTIN_LOGO): text wordmark, no logo, no (R).
    // Assert on the ELEMENTS - the CSS rules for these classes always ship in <style>.
    expect(data).toContain('Built with <strong>');
    expect(data).not.toContain('<span class="b4m-bar-logo">');
    expect(data).not.toContain('<span class="b4m-reg">');
  });

  it('own-tab bar ships the built-in spoke logo + registered mark when opted in', async () => {
    // The logo/(R) are gated on NEXT_PUBLIC_SHARE_BUILTIN_LOGO (read at module load),
    // so import a fresh copy of the handler with the flag set. The vi.mock factories
    // + hoisted mocks re-apply on re-import, so the same DB/storage stubs drive it.
    const prev = process.env.NEXT_PUBLIC_SHARE_BUILTIN_LOGO;
    process.env.NEXT_PUBLIC_SHARE_BUILTIN_LOGO = 'true';
    vi.resetModules();
    try {
      const freshHandler = (await import('../[...path]')).default as unknown as (
        req: unknown,
        res: unknown
      ) => Promise<void>;
      mockArtifactFindOne.mockReturnValue(bundle());
      mockDownload.mockResolvedValue(Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));
      const { req, res } = createMocks({
        method: 'GET',
        query: { path: ['u', 'scope123', 'my-slug'] },
        headers: { host: 'app.bike4mind.com' },
      });
      await freshHandler(req, res);
      const data = res._getData() as string;
      // Spoke-wheel logo (inlined SVG) instead of the text wordmark, plus the (R) on bar + CTA.
      expect(data).toContain('<span class="b4m-bar-logo">');
      expect(data).toContain('<svg');
      expect(data).not.toContain('Built with <strong>');
      expect((data.match(/<span class="b4m-reg">&reg;<\/span>/g) ?? []).length).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_SHARE_BUILTIN_LOGO;
      else process.env.NEXT_PUBLIC_SHARE_BUILTIN_LOGO = prev;
      vi.resetModules();
    }
  });
});

describe('GET /api/publish/serve - search-engine discoverability is opt-in', () => {
  const ROBOTS_META = '<meta name="robots" content="noindex,nofollow">';

  it('a public bundle is NOT indexable by default (no `discoverable` on the record)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(res._getData() as string).toContain(ROBOTS_META);
  });

  it('an explicitly non-discoverable public bundle is noindexed', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ discoverable: false }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(res._getData() as string).toContain(ROBOTS_META);
  });

  it('opting in drops BOTH the robots header and the meta - the only indexable case', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ discoverable: true }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Robots-Tag')).toBeUndefined();
    expect(res._getData() as string).not.toContain('name="robots"');
  });

  it('opting in does NOT survive a gate: discoverable + accessGate is still noindexed', async () => {
    // The serve route ANDs `discoverable` with isOpenPublic, so a stale opt-in left on a
    // newly-gated artifact can never re-expose it to crawlers.
    mockArtifactFindOne.mockReturnValue(bundle({ discoverable: true, accessGate: { kind: 'passphrase' } }));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('opting in does NOT survive a visibility downgrade: discoverable + private is noindexed', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ discoverable: true, visibility: 'private' }));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { user: { id: 'owner1' } });
    await promise;

    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('a share-token link is noindexed even when the artifact opted in', async () => {
    // Possession of the token is the capability; an unlisted link must never be
    // reachable from a search result regardless of the owner's discovery choice.
    mockArtifactFindOne.mockReturnValue(bundle({ discoverable: true }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['a', 'tok123']);
    await promise;

    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(res._getData() as string).toContain(ROBOTS_META);
  });

  it('keeps OG/unfurl meta on a non-discoverable public page - previews are not indexing', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ description: 'A thing' }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain(ROBOTS_META);
    // Unfurlers read OG tags and ignore robots directives, so a link pasted into a chat
    // app still renders a card while the page stays out of the search index.
    expect(data).toContain('og:title');
  });

  // The reply/fabfile viewer page is a SEPARATE render path from the bundle wrapper
  // (renderViewerPage vs renderBundleWrapper), and it is where most published LLM output
  // lands. Reverting just that call site to `isShare` must not pass.
  const publicReply = (over: Record<string, unknown> = {}) => ({
    publicId: 'rep1',
    title: 'My Reply',
    visibility: 'public',
    ownerId: 'owner1',
    source: { kind: 'reply' },
    renderedBody: '# Hello',
    storageKeyPrefix: '',
    manifest: [],
    tier: 'user',
    scopeId: 'scope123',
    slug: 'r-pub',
    ...over,
  });

  it('noindexes a public REPLY viewer page by default', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply());

    const { res, promise } = run(['r', 'rep1']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(res._getData() as string).toContain(ROBOTS_META);
  });

  it('drops the robots meta from a REPLY viewer page once opted in', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply({ discoverable: true }));

    const { res, promise } = run(['r', 'rep1']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Robots-Tag')).toBeUndefined();
    expect(res._getData() as string).not.toContain('name="robots"');
  });

  it('noindexes a public FABFILE viewer page by default', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply({ source: { kind: 'fabfile' }, publicId: 'fab1' }));

    const { res, promise } = run(['f', 'fab1']);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain(ROBOTS_META);
  });

  it('noindexes a superseded ?v=<sha> render even when opted in', async () => {
    // The version switcher emits real crawlable anchors, so a replaced v1 stays
    // reachable; rel=canonical is a hint, not a guarantee.
    mockArtifactFindOne.mockReturnValue(
      bundle({ discoverable: true, sha256Index: 'shaCURRENT', versions: [{ sha256Index: 'shaOLD' }] })
    );
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Old</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { v: 'shaOLD' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('noindexes ?format=raw even when opted in - text/plain cannot carry a meta tag', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ discoverable: true }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { format: 'raw' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('noindexes an individual bundle ASSET even when opted in', async () => {
    mockArtifactFindOne.mockReturnValue(
      bundle({
        discoverable: true,
        manifest: [
          { path: 'index.html', mimeType: 'text/html' },
          { path: 'page2.html', mimeType: 'text/html' },
        ],
      })
    );
    mockDownload.mockResolvedValue(Buffer.from('<html><body>two</body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug', 'page2.html']);
    await promise;

    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('keeps no-referrer scoped to share links, not every noindexed public page', async () => {
    // no-referrer exists to stop a share TOKEN leaking via Referer. Riding it along with
    // the robots meta would make it the default for every public page - killing outbound
    // referral attribution and blanking document.referrer inside the isolated bundle.
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain(ROBOTS_META);
    expect(data).not.toContain('name="referrer"');
    expect(res.getHeader('Referrer-Policy')).toBeUndefined();
  });

  it('still emits BOTH robots and referrer meta on a share link', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['a', 'tok123']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain(ROBOTS_META);
    expect(data).toContain('<meta name="referrer" content="no-referrer">');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
  });

  it('does NOT index the isolated usercontent origin, even when opted in', async () => {
    // The /uc origin serves the bare bundle with no wrapper, branding, or canonical
    // link. Opting in must make exactly one URL indexable: the canonical /p page.
    mockArtifactFindOne.mockReturnValue(bundle({ discoverable: true }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { uc: 'pub1' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('does NOT index the embed render, even when opted in', async () => {
    // An embed is meant to be framed inside someone else's page, not to stand alone
    // as a search result competing with the canonical page.
    mockArtifactFindOne.mockReturnValue(bundle({ discoverable: true }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { embed: true });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('the ?format=raw plain-text surface is noindexed unless opted in', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { format: 'raw' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });
});

describe('GET /api/publish/serve - ?export= content export (issue #1142)', () => {
  const publicReply = (over: Record<string, unknown> = {}) => ({
    publicId: 'rexp',
    title: 'My Reply',
    description: 'A short blurb',
    visibility: 'public',
    ownerId: 'owner1',
    source: { kind: 'reply' },
    renderedBody: '## Heading\n\nSome *markdown* body.',
    storageKeyPrefix: '',
    manifest: [],
    tier: 'user',
    scopeId: 's',
    slug: 'rexp',
    ...over,
  });

  it('exports a reply as Markdown: attachment, title heading, body verbatim', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply());
    const { res, promise } = run(['r', 'rexp'], { exportAs: 'md' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.getHeader('Content-Disposition')).toBe('attachment; filename="my-reply.md"');
    expect(res.getHeader('X-Content-Type-Options')).toBe('nosniff');
    // Author bytes never render on the app origin: attachment + nosniff + a sandbox CSP.
    expect(res.getHeader('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    const data = res._getData() as string;
    expect(data).toBe('# My Reply\n\nA short blurb\n\n## Heading\n\nSome *markdown* body.\n');
  });

  it('exports a reply as a STANDALONE html file - no CSP meta, no root-relative report link', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply());
    const { res, promise } = run(['r', 'rexp'], { exportAs: 'html' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.getHeader('Content-Disposition')).toBe('attachment; filename="my-reply.html"');
    const data = res._getData() as string;
    expect(data).toContain('<h2>Heading</h2>');
    // A downloaded file resolves nothing against the app origin, so the served-page-only
    // chrome is dropped (the CSP meta would also kill inlined artifacts' JS).
    expect(data).not.toContain('http-equiv="Content-Security-Policy"');
    expect(data).not.toContain('/report/rexp');
    expect(data).not.toContain('?export=');
  });

  it('inlines an embedded html artifact as srcdoc in a standalone export (not a ?a= URL)', async () => {
    mockArtifactFindOne.mockReturnValue(
      publicReply({
        renderedBody:
          '<artifact identifier="t" type="text/html" title="Tip"><html><body><script>window.ok=1</script></body></html></artifact>',
      })
    );
    const { res, promise } = run(['r', 'rexp'], { exportAs: 'html' });
    await promise;

    const data = res._getData() as string;
    expect(data).toContain('srcdoc=');
    expect(data).not.toContain('?a=0');
    // Same opaque-origin posture as the served page; the artifact's own JS travels with it.
    expect(data).toContain('sandbox="allow-scripts"');
    expect(data).toContain('window.ok=1');
  });

  it('exports a fabfile as html but 404s a Markdown request (no faithful conversion)', async () => {
    const fab = publicReply({ publicId: 'fexp', source: { kind: 'fabfile' }, renderedBody: 'col_a,col_b\n1,2\n' });
    mockArtifactFindOne.mockReturnValue(fab);
    const { res, promise } = run(['f', 'fexp'], { exportAs: 'html' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('col_a,col_b');

    mockArtifactFindOne.mockReturnValue(fab);
    const md = run(['f', 'fexp'], { exportAs: 'md' });
    await md.promise;
    expect(md.res._getStatusCode()).toBe(404);
  });

  it('exports a bundle as a self-contained html file with its assets inlined', async () => {
    mockArtifactFindOne.mockReturnValue(
      bundle({
        manifest: [
          { path: 'index.html', mimeType: 'text/html' },
          { path: 'logo.png', mimeType: 'image/png' },
        ],
      })
    );
    mockDownload.mockImplementation((key: string) =>
      Promise.resolve(
        key.endsWith('index.html')
          ? Buffer.from('<html><body><img src="logo.png"><h1>Hi</h1></body></html>')
          : Buffer.from([1, 2, 3])
      )
    );

    const { res, promise } = run(['u', 'scope123', 'my-slug'], { exportAs: 'html' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Disposition')).toBe('attachment; filename="my-artifact.html"');
    const data = res._getData() as string;
    // Assets inline even though the artifact is PUBLIC (the served view would use <base>):
    // a downloaded file has no route to fetch them back through.
    expect(data).toContain('data:image/png;base64,');
    expect(data).not.toContain('<base href=');
  });

  it('404s a Markdown export of a bundle', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { exportAs: 'md' });
    await promise;
    expect(res._getStatusCode()).toBe(404);
    expect(mockDownload).not.toHaveBeenCalled(); // rejected before touching storage
  });

  it('404s an unknown export format, and ignores an empty one', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply());
    const pdf = run(['r', 'rexp'], { exportAs: 'pdf' });
    await pdf.promise;
    expect(pdf.res._getStatusCode()).toBe(404);

    // `?export=` with no value falls through to the normal page render.
    mockArtifactFindOne.mockReturnValue(publicReply());
    const empty = run(['r', 'rexp'], { exportAs: '' });
    await empty.promise;
    expect(empty.res._getStatusCode()).toBe(200);
    expect(empty.res.getHeader('Content-Type')).toBe('text/html; charset=utf-8');
    expect(empty.res.getHeader('Content-Disposition')).toBeUndefined();
  });

  it('is never search-indexable, even for a discoverable open-public artifact', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply({ discoverable: true }));
    const { res, promise } = run(['r', 'rexp'], { exportAs: 'md' });
    await promise;
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('hard-fails an anonymous export of a gated reply instead of returning the loader shell', async () => {
    // The shell recovers a NAVIGATION by re-fetching ?raw=1, which yields the page - so a
    // shell delivered as a download would dead-end. 401, and never the body.
    mockArtifactFindOne.mockReturnValue(
      publicReply({ visibility: 'organization', tier: 'organization', scopeId: 'org_1' })
    );
    const { res, promise } = run(['r', 'rexp'], { exportAs: 'md' });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    const data = res._getData() as string;
    expect(data).not.toContain('Some *markdown* body.');
    expect(data).not.toContain('b4m-frame'); // not the loader shell either
    expect(res.getHeader('Content-Disposition')).toBeUndefined();
  });

  it('403s an export for an authenticated viewer the gate rejects', async () => {
    mockArtifactFindOne.mockReturnValue(
      publicReply({ visibility: 'organization', tier: 'organization', scopeId: 'org_1' })
    );
    const { res, promise } = run(['r', 'rexp'], { exportAs: 'md', user: { id: 'other', organizationId: 'org_9' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
  });

  it('exports for an authorized org member', async () => {
    mockArtifactFindOne.mockReturnValue(
      publicReply({ visibility: 'organization', tier: 'organization', scopeId: 'org_1' })
    );
    const { res, promise } = run(['r', 'rexp'], { exportAs: 'md', user: { id: 'other', organizationId: 'org_1' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('Some *markdown* body.');
  });

  it('exports through a /a/<shareToken> link, no-store and no-referrer', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply({ visibility: 'private', shareToken: 'tok123' }));
    const { res, promise } = run(['a', 'tok123'], { exportAs: 'md' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('Some *markdown* body.');
    expect(res.getHeader('Cache-Control')).toContain('no-store');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('404s an export on the isolated usercontent origin (bare bundle, no app affordances)', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { uc: 'pub1', exportAs: 'html' });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('never shared-caches an export, not even an open-public one', async () => {
    // A cached `?export=` would be an ATTACHMENT served in place of the page on any shared
    // cache that does not key on the query string. Same reasoning as the `?v=` cold path.
    mockArtifactFindOne.mockReturnValue(publicReply());
    const { res, promise } = run(['r', 'rexp'], { exportAs: 'md' });
    await promise;
    expect(res.getHeader('Cache-Control')).toBe('private, no-store, must-revalidate');

    mockArtifactFindOne.mockReturnValue(
      publicReply({ visibility: 'organization', tier: 'organization', scopeId: 'org_1' })
    );
    const gated = run(['r', 'rexp'], { exportAs: 'md', user: { id: 'other', organizationId: 'org_1' } });
    await gated.promise;
    expect(gated.res.getHeader('Cache-Control')).toContain('no-store');
  });
});

describe('GET /api/publish/serve - export affordances on the viewer surfaces (issue #1142)', () => {
  const publicReply = (over: Record<string, unknown> = {}) => ({
    publicId: 'rexp',
    title: 'My Reply',
    visibility: 'public',
    ownerId: 'owner1',
    source: { kind: 'reply' },
    renderedBody: 'body text',
    storageKeyPrefix: '',
    manifest: [],
    tier: 'user',
    scopeId: 's',
    slug: 'rexp',
    ...over,
  });

  it('offers Markdown + HTML downloads on an open-public reply page, with no script', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply());
    const { res, promise } = run(['r', 'rexp']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain('href="/p/r/rexp?export=md" download');
    expect(data).toContain('href="/p/r/rexp?export=html" download');
    // The page is served script-src 'none' - the affordance must be pure markup.
    expect(data).not.toContain('<script');
  });

  it('offers only HTML on a fabfile page (no faithful Markdown form)', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply({ publicId: 'fexp', source: { kind: 'fabfile' }, slug: 'fexp' }));
    const { res, promise } = run(['f', 'fexp']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain('href="/p/f/fexp?export=html" download');
    expect(data).not.toContain('?export=md');
  });

  it('points the links at the token path on a /a/<shareToken> view', async () => {
    mockArtifactFindOne.mockReturnValue(publicReply({ visibility: 'private', shareToken: 'tok123' }));
    const { res, promise } = run(['a', 'tok123']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain('href="/a/tok123?export=md" download');
    expect(data).not.toContain('/p/r/rexp?export=');
  });

  it('omits the links on a Bearer-gated reply, which would answer the click with the loader shell', async () => {
    mockArtifactFindOne.mockReturnValue(
      publicReply({ visibility: 'organization', tier: 'organization', scopeId: 'org_1' })
    );
    const { res, promise } = run(['r', 'rexp'], { user: { id: 'other', organizationId: 'org_1' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const data = res._getData() as string;
    expect(data).toContain('body text'); // authorized, page rendered
    expect(data).not.toContain('?export=');
  });

  it('puts "Save as HTML" in the lead-gen bar on an own-tab open-public bundle', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));
    const { res, promise } = run(['u', 'scope123', 'my-slug']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain('class="b4m-bar-export"');
    expect(data).toContain('href="/p/u/scope123/my-slug?export=html" download');
  });

  it('drops the bundle export affordance in chrome-less embed mode', async () => {
    mockArtifactFindOne.mockReturnValue(bundle());
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));
    const { res, promise } = run(['u', 'scope123', 'my-slug'], { embed: true });
    await promise;

    expect(res._getData() as string).not.toContain('?export=');
  });

  it('offers the bundle export as a floating chip on a share-token view', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'private' }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));
    const { res, promise } = run(['a', 'tok123']);
    await promise;

    const data = res._getData() as string;
    expect(data).toContain('<div class="b4m-actions">');
    expect(data).toContain('class="b4m-export"');
    expect(data).toContain('href="/a/tok123?export=html" download');
  });

  it('omits the links on a DOMAIN-gated share link, whose gate reads req.user', async () => {
    // Possession of the token is not enough for a domain gate, and a `?export=` navigation
    // carries no Bearer - so the link would 401. Stricter than canFrameArtifacts on purpose.
    mockArtifactFindOne.mockReturnValue(
      publicReply({ shareToken: 'tok123', accessGate: { kind: 'domain', allowedDomains: ['acme.com'] } })
    );
    mockUserFindById.mockResolvedValue({ email: 'a@acme.com', emailVerified: true });
    const { res, promise } = run(['a', 'tok123'], { user: { id: 'u1' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).not.toContain('?export=');
  });

  it('offers the links on a passphrase-verified page - the proof cookie rides the navigation', async () => {
    const { signGateToken } = await import('@server/services/publish/publishGateToken');
    mockArtifactFindOne.mockReturnValue(publicReply({ accessGate: { kind: 'passphrase' } }));
    const { res, promise } = run(['r', 'rexp'], { cookie: `b4m_pg_rexp=${signGateToken({ publicId: 'rexp' })}` });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).toContain('?export=md');
  });

  it('omits the bundle export affordance for a Bearer-gated bundle', async () => {
    mockArtifactFindOne.mockReturnValue(bundle({ visibility: 'organization', tier: 'organization', scopeId: 'org_1' }));
    mockDownload.mockResolvedValue(Buffer.from('<html><body><h1>Hi</h1></body></html>'));
    const { res, promise } = run(['u', 'org_1', 'my-slug'], { user: { id: 'other', organizationId: 'org_1' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData() as string).not.toContain('?export=');
  });
});

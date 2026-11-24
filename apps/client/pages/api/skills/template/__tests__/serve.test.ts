// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  find: vi.fn(),
  record: vi.fn(),
  imageFile: vi.fn(),
  signFileUrl: vi.fn(),
  audience: vi.fn(),
  credits: vi.fn(),
  freeRun: vi.fn(),
  baseApiOptions: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  chain.use = () => chain;
  chain.get = (fn: unknown) => fn;
  return {
    baseApi: (options: unknown) => {
      h.baseApiOptions.push(options);
      return chain;
    },
  };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
// A `Bearer <userId>` header signs that user in; anything else stays anonymous.
vi.mock('@server/middlewares/optionalJwtAuth', () => ({
  optionalJwtAuth:
    () => (req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
      if (match) req.user = { id: match[1] };
      next();
    },
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/server-utils/skillMarket/market')>(
    '@bike4mind/server-utils/skillMarket/market'
  );
  return { canSeeListing: actual.canSeeListing, audienceIdsFor: h.audience };
});
vi.mock('@server/skillMarket/templateImage', () => ({
  isPublicTemplatePage: (listing: { visibility: string }) => ['public', 'unlisted'].includes(listing.visibility),
  templatePageImageFile: h.imageFile,
  templateImageDeps: () => ({ signFileUrl: h.signFileUrl }),
}));
vi.mock('@server/skillMarket/templatePage', async () => {
  const actual = await vi.importActual<typeof import('@server/skillMarket/templatePage')>(
    '@server/skillMarket/templatePage'
  );
  return { ...actual, findServableTemplate: h.find, recordTemplateView: h.record };
});
vi.mock('@server/skillMarket/templateFreeRun', () => ({ freeRunPageState: h.freeRun }));
vi.mock('@server/utils/starterCredits', () => ({ getOpenSignupStarterCredits: h.credits }));
vi.mock('@client/config/general', () => ({ getBrandName: () => 'Acme' }));

import handler from '../serve';
import {
  MERMAID_SCRIPT_SRC,
  TEMPLATE_FREE_RUN_SCRIPT_HASH,
  TEMPLATE_LOADER_SCRIPT_HASH,
} from '@server/skillMarket/templatePage';

const template = (over: Record<string, unknown> = {}) => ({
  _id: 'tpl-1',
  listingId: 'listing-1',
  slug: 'article-bullets',
  headline: 'Turn any article into five bullets',
  inputs: [
    { label: 'An article', required: true },
    { label: 'A tone', required: false },
  ],
  previewImage: { fabFileId: 'file-1', source: 'upload', approved: true },
  ...over,
});

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'listing-1',
  name: 'article-bullets',
  status: 'approved',
  visibility: 'public',
  organizationId: undefined,
  authorUserId: 'author-1',
  currentApprovedVersionId: 'v1',
  hiddenByReports: false,
  deletedAt: null,
  shareToken: 'share-token',
  ...over,
});

const call = (
  query: Record<string, unknown>,
  headers: Record<string, string> = { accept: 'text/html', host: 'localhost:3000' }
) => {
  const { req, res } = createMocks({
    method: 'GET',
    query: query as never,
    headers: { 'x-forwarded-proto': 'https', ...headers },
  });
  return { res, run: () => (handler as unknown as (a: unknown, b: unknown) => Promise<unknown>)(req, res) };
};

const body = (res: { _getData: () => unknown }) => String(res._getData());

beforeEach(() => {
  vi.clearAllMocks();
  h.find.mockResolvedValue({ template: template(), listing: listing() });
  h.record.mockResolvedValue(undefined);
  h.imageFile.mockResolvedValue({ filePath: 'files/img-1.jpg', mimeType: 'image/jpeg' });
  h.signFileUrl.mockResolvedValue('https://files.example.com/img-1.jpg?sig=1');
  h.audience.mockResolvedValue({ orgIds: [], spaceIds: [] });
  h.credits.mockResolvedValue(2500);
  h.freeRun.mockResolvedValue(null);
});

describe('GET /t/[slug]', () => {
  it('is a public, GET-only route', () => {
    expect(h.baseApiOptions).toEqual([{ auth: false, allowedMethods: ['GET'] }]);
  });

  describe('not found', () => {
    it.each(['Upper', '-lead', '../x', 'x'.repeat(65), ['a', 'b'], undefined])(
      '404s malformed slug %j without a lookup',
      async slug => {
        const { res, run } = call({ slug });
        await run();
        expect(res.statusCode).toBe(404);
        expect(h.find).not.toHaveBeenCalled();
      }
    );

    it('404s a slug with no servable template, as a page for a browser', async () => {
      h.find.mockResolvedValue(null);
      const { res, run } = call({ slug: 'article-bullets' });
      await run();

      expect(res.statusCode).toBe(404);
      expect(res.getHeader('Content-Type')).toBe('text/html; charset=utf-8');
      expect(body(res)).toContain('data-testid="publish-not-found"');
      expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(h.record).not.toHaveBeenCalled();
    });

    it('404s as JSON for a non-browser caller', async () => {
      h.find.mockResolvedValue(null);
      const { res, run } = call({ slug: 'article-bullets' }, { accept: 'application/json' });
      await run();
      expect(res.statusCode).toBe(404);
      expect(res._getJSONData()).toEqual({ error: 'Not found' });
    });
  });

  describe.each(['public', 'unlisted'])('a %s listing', visibility => {
    beforeEach(() => h.find.mockResolvedValue({ template: template(), listing: listing({ visibility }) }));

    it('renders logged out with link-preview tags, the image and the try button', async () => {
      const { res, run } = call({ slug: 'article-bullets' });
      await run();
      const html = body(res);

      expect(res.statusCode).toBe(200);
      expect(res.getHeader('Content-Type')).toBe('text/html; charset=utf-8');
      expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(res.getHeader('Cache-Control')).toBe('private, no-store');
      expect(String(res.getHeader('Content-Security-Policy'))).toContain("default-src 'none'");
      expect(String(res.getHeader('Content-Security-Policy'))).not.toContain('script-src');

      const imagePath = '/api/skills/template/image/article-bullets?v=file-1';
      expect(html).toContain('<meta property="og:title" content="Turn any article into five bullets">');
      expect(html).toContain('<meta property="og:url" content="https://localhost:3000/t/article-bullets">');
      expect(html).toContain(`<meta property="og:image" content="https://localhost:3000${imagePath}">`);
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(html).toContain(
        '<meta name="description" content="Acme skill /article-bullets. You bring: An article, A tone (optional).">'
      );
      expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
      expect(html).toContain(`src="${imagePath}"`);
      expect(html).toContain('Acme skill <code>/article-bullets</code>');
      expect(html).toContain('href="/skills/market/try/article-bullets"');
      expect(html).toContain('New accounts start with 2,500 free credits.');
      expect(html).not.toContain('<script');
      expect(h.record).toHaveBeenCalledTimes(1);
    });
  });

  it('shows no starter-credit line when open registration grants nothing', async () => {
    h.credits.mockResolvedValue(0);
    const { res, run } = call({ slug: 'article-bullets' });
    await run();
    expect(body(res)).not.toContain('template-page-starter-credits');
  });

  it('falls back to a small card with no image when none is ready', async () => {
    h.imageFile.mockResolvedValue(null);
    const { res, run } = call({ slug: 'article-bullets' });
    await run();
    const html = body(res);
    expect(html).not.toMatch(/og:image|twitter:image|<img/);
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  it('still serves the page when the view count write fails', async () => {
    h.record.mockRejectedValue(new Error('db down'));
    const { res, run } = call({ slug: 'article-bullets' });
    await run();
    expect(res.statusCode).toBe(200);
  });

  describe('an organization listing', () => {
    beforeEach(() =>
      h.find.mockResolvedValue({
        template: template(),
        listing: listing({ visibility: 'organization', organizationId: 'org-1' }),
      })
    );

    it('serves a navigation the data-free sign-in loader', async () => {
      const { res, run } = call({ slug: 'article-bullets' });
      await run();
      const html = body(res);

      expect(res.statusCode).toBe(200);
      expect(html).toContain('data-testid="template-page-loader"');
      expect(html).not.toContain('Turn any article');
      expect(html).not.toMatch(/og:|twitter:/);
      expect(String(res.getHeader('Content-Security-Policy'))).toContain(`script-src ${TEMPLATE_LOADER_SCRIPT_HASH}`);
      expect(h.audience).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    });

    it('refuses the raw render without a session', async () => {
      const { res, run } = call({ slug: 'article-bullets', raw: '1' });
      await run();
      expect(res.statusCode).toBe(401);
      expect(h.record).not.toHaveBeenCalled();
    });

    it('404s a signed-in user outside the organization', async () => {
      h.audience.mockResolvedValue({ orgIds: ['org-2'], spaceIds: [] });
      const { res, run } = call(
        { slug: 'article-bullets', raw: '1' },
        { accept: '*/*', host: 'localhost:3000', authorization: 'Bearer outsider' }
      );
      await run();
      expect(h.audience).toHaveBeenCalledWith('outsider');
      expect(res.statusCode).toBe(404);
      expect(h.record).not.toHaveBeenCalled();
    });

    it('renders for a member with no link-preview tags, no credit line and a signed image', async () => {
      h.audience.mockResolvedValue({ orgIds: ['org-1'], spaceIds: [] });
      const { res, run } = call(
        { slug: 'article-bullets', raw: '1' },
        { accept: '*/*', host: 'localhost:3000', authorization: 'Bearer member' }
      );
      await run();
      const html = body(res);

      expect(res.statusCode).toBe(200);
      expect(res.getHeader('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(html).toContain('Turn any article into five bullets');
      expect(html).not.toMatch(/og:|twitter:|rel="canonical"/);
      expect(html).toContain('src="https://files.example.com/img-1.jpg?sig=1"');
      expect(html).not.toContain('template-page-starter-credits');
      expect(h.credits).not.toHaveBeenCalled();
      expect(h.record).toHaveBeenCalledTimes(1);
    });
  });

  it('escapes every author-supplied string', async () => {
    h.find.mockResolvedValue({
      template: template({
        headline: '<script>alert(1)</script>',
        inputs: [{ label: '"><img src=x onerror=alert(1)>', required: true }],
      }),
      listing: listing({ name: 'a"b<c' }),
    });
    const { res, run } = call({ slug: 'article-bullets' });
    await run();
    const html = body(res);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('/a&quot;b&lt;c');
  });

  describe('free run', () => {
    const csp = (res: { getHeader: (name: string) => unknown }) => String(res.getHeader('Content-Security-Policy'));

    it('passes the visitor cookie to the free-run state', async () => {
      const { run } = call({ slug: 'article-bullets' }, { accept: 'text/html', host: 'localhost:3000', cookie: 'a=1' });
      await run();
      expect(h.freeRun).toHaveBeenCalledWith(expect.objectContaining({ _id: 'tpl-1' }), expect.anything(), 'a=1');
    });

    it('allows the box script, Turnstile and the pinned mermaid build only on a page with the box', async () => {
      h.freeRun.mockResolvedValue({ state: 'open', siteKey: 'site', inputMaxChars: 8000 });
      const { res, run } = call({ slug: 'article-bullets' });
      await run();
      expect(body(res)).toContain('data-testid="template-page-free-run"');
      expect(csp(res)).toContain(
        `script-src ${TEMPLATE_FREE_RUN_SCRIPT_HASH} https://challenges.cloudflare.com ${MERMAID_SCRIPT_SRC}`
      );
      expect(csp(res)).toContain('frame-src https://challenges.cloudflare.com');
      expect(csp(res)).toContain("connect-src 'self'");
    });

    it('keeps the script-free CSP for the sign-up prompt', async () => {
      h.freeRun.mockResolvedValue({ state: 'used' });
      const { res, run } = call({ slug: 'article-bullets' });
      await run();
      expect(body(res)).toContain('data-testid="template-page-free-run-signup"');
      expect(csp(res)).not.toContain('script-src');
    });

    it('still serves the page, without the box, when the free-run state cannot be read', async () => {
      h.freeRun.mockRejectedValue(new Error('db down'));
      const { res, run } = call({ slug: 'article-bullets' });
      await run();
      expect(res.statusCode).toBe(200);
      expect(body(res)).not.toContain('template-page-free-run');
    });
  });
});

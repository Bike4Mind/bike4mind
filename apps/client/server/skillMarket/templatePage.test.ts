// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  updateOne: vi.fn(),
  findListing: vi.fn(),
  marks: new Set<string>(),
}));

vi.mock('@bike4mind/database', () => ({
  SkillListingTemplate: { findOne: h.findOne, updateOne: h.updateOne },
  cacheRepository: {
    // CacheModel.test.ts covers the real claimDedup against Mongo.
    claimDedup: async (key: string) => {
      const claimed = !h.marks.has(key);
      h.marks.add(key);
      return { claimed };
    },
  },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ findListing: h.findListing }));
vi.mock('./template', () => ({
  isLive: (l: { status: string; currentApprovedVersionId?: string; hiddenByReports?: boolean }) =>
    l.status === 'approved' && !!l.currentApprovedVersionId && !l.hiddenByReports,
}));

import {
  MERMAID_SCRIPT_SRC,
  compactCount,
  TEMPLATE_FREE_RUN_SCRIPT_HASH,
  TEMPLATE_LOADER_SCRIPT_HASH,
  findServableTemplate,
  recordTemplateTry,
  recordTemplateView,
  renderTemplateLoaderShell,
  templateViewMarkKey,
  renderTemplatePage,
  type TemplatePageView,
} from './templatePage';

const lean = (value: unknown) => ({ select: () => ({ lean: async () => value }) });
const liveListing = { id: 'l1', status: 'approved', currentApprovedVersionId: 'v1', hiddenByReports: false };

beforeEach(() => vi.clearAllMocks());

describe('findServableTemplate', () => {
  it('only looks up a published template', async () => {
    h.findOne.mockReturnValue(lean(null));
    expect(await findServableTemplate('article-bullets')).toBeNull();
    expect(h.findOne).toHaveBeenCalledWith({ slug: 'article-bullets', status: 'published' });
    expect(h.findListing).not.toHaveBeenCalled();
  });

  it.each([
    ['missing or deleted', null],
    ['withdrawn', { ...liveListing, status: 'withdrawn' }],
    ['delisted', { ...liveListing, status: 'delisted' }],
    ['not approved', { ...liveListing, status: 'pending' }],
    ['hidden by reports', { ...liveListing, hiddenByReports: true }],
  ])('is null when the listing is %s', async (_case, listing) => {
    h.findOne.mockReturnValue(lean({ _id: 't1', listingId: 'l1', slug: 'article-bullets' }));
    h.findListing.mockResolvedValue(listing);
    expect(await findServableTemplate('article-bullets')).toBeNull();
    expect(h.findListing).toHaveBeenCalledWith('l1');
  });

  it('returns the template and its live listing', async () => {
    const template = { _id: 't1', listingId: 'l1', slug: 'article-bullets' };
    h.findOne.mockReturnValue(lean(template));
    h.findListing.mockResolvedValue(liveListing);
    expect(await findServableTemplate('article-bullets')).toEqual({ template, listing: liveListing });
  });
});

describe('recordTemplateView', () => {
  const visitor = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 Chrome/126.0' };
  const noon = new Date('2026-11-26T12:00:00Z');

  beforeEach(() => {
    h.marks.clear();
    h.updateOne.mockReset().mockResolvedValue({});
  });

  it('increments the view count on the first visit', async () => {
    expect(await recordTemplateView({ _id: 't1' } as never, visitor, noon)).toBe(true);
    expect(h.updateOne).toHaveBeenCalledWith({ _id: 't1' }, { $inc: { viewCount: 1 } }, { runValidators: true });
  });

  it('counts a reload by the same visitor on the same UTC day once', async () => {
    await recordTemplateView({ _id: 't1' } as never, visitor, noon);
    expect(await recordTemplateView({ _id: 't1' } as never, visitor, new Date('2026-11-26T23:59:59Z'))).toBe(false);
    expect(h.updateOne).toHaveBeenCalledTimes(1);
  });

  it('counts the same visitor again on the next UTC day, and on another page', async () => {
    await recordTemplateView({ _id: 't1' } as never, visitor, noon);
    expect(await recordTemplateView({ _id: 't1' } as never, visitor, new Date('2026-11-27T00:00:01Z'))).toBe(true);
    expect(await recordTemplateView({ _id: 't2' } as never, visitor, noon)).toBe(true);
    expect(h.updateOne).toHaveBeenCalledTimes(3);
  });

  it('counts different visitors separately', async () => {
    await recordTemplateView({ _id: 't1' } as never, visitor, noon);
    expect(await recordTemplateView({ _id: 't1' } as never, { ...visitor, ip: '198.51.100.2' }, noon)).toBe(true);
    expect(await recordTemplateView({ _id: 't1' } as never, { ...visitor, userAgent: 'Firefox/130.0' }, noon)).toBe(
      true
    );
    expect(await recordTemplateView({ _id: 't1' } as never, { ...visitor, userId: 'u1' }, noon)).toBe(true);
    expect(h.updateOne).toHaveBeenCalledTimes(4);
  });

  it('counts a signed-in visitor once a day across networks', async () => {
    await recordTemplateView({ _id: 't1' } as never, { ...visitor, userId: 'u1' }, noon);
    expect(await recordTemplateView({ _id: 't1' } as never, { ip: '198.51.100.2', userId: 'u1' }, noon)).toBe(false);
  });

  it('stores no raw IP, user agent or user id in the mark key', () => {
    const key = templateViewMarkKey('t1', { ...visitor, userId: 'user-42' }, noon);
    expect(key).toMatch(/^skill-template-view:[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain('203.0.113.7');
    expect(key).not.toContain('user-42');
    expect(key).not.toContain('2026-11-26');
  });
});

describe('compactCount', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1000, '1k'],
    [1234, '1.2k'],
    [1299, '1.2k'],
    [12_500, '12.5k'],
    [999_999, '999.9k'],
    [1_000_000, '1M'],
    [3_456_789, '3.4M'],
    [2_000_000_000, '2B'],
  ])('formats %i as %s', (n, expected) => {
    expect(compactCount(n)).toBe(expected);
  });
});

describe('recordTemplateTry', () => {
  it('increments the try count', async () => {
    h.updateOne.mockResolvedValue({});
    await recordTemplateTry({ _id: 't1' } as never);
    expect(h.updateOne).toHaveBeenCalledWith({ _id: 't1' }, { $inc: { tryCount: 1 } }, { runValidators: true });
  });
});

describe('renderTemplatePage', () => {
  const view: TemplatePageView = {
    slug: 'article-bullets',
    skillName: 'article-bullets',
    headline: 'Five bullets',
    inputs: [
      { label: 'An article', required: true },
      { label: 'A tone', required: false },
    ],
    imageSrc: null,
    starterCredits: 0,
    brandName: 'Acme',
    share: null,
  };

  describe('metrics line', () => {
    const metrics = (html: string) => /data-testid="template-page-metrics">([^<]*)</.exec(html)?.[1];

    it('shows views and downloads under the byline, compactly', () => {
      const html = renderTemplatePage({ ...view, metrics: { views: 1234, downloads: 87 } });
      expect(metrics(html)).toBe('1.2k views \u00b7 87 downloads');
      expect(html.indexOf('template-page-byline')).toBeLessThan(html.indexOf('template-page-metrics'));
    });

    it('leaves out a zero count', () => {
      expect(metrics(renderTemplatePage({ ...view, metrics: { views: 5, downloads: 0 } }))).toBe('5 views');
      expect(metrics(renderTemplatePage({ ...view, metrics: { views: 0, downloads: 2 } }))).toBe('2 downloads');
    });

    it('uses the singular for one', () => {
      expect(metrics(renderTemplatePage({ ...view, metrics: { views: 1, downloads: 1 } }))).toBe(
        '1 view \u00b7 1 download'
      );
    });

    it('renders no line when both counts are zero or missing', () => {
      for (const m of [{ views: 0, downloads: 0 }, null, undefined]) {
        expect(renderTemplatePage({ ...view, metrics: m })).not.toContain('template-page-metrics');
      }
    });
  });

  describe('free run', () => {
    const open = { state: 'open', siteKey: 'site-"key', inputMaxChars: 8000 } as const;

    it('renders no box and no script when the free run is hidden', () => {
      for (const freeRun of [undefined, null]) {
        const html = renderTemplatePage({ ...view, freeRun });
        expect(html).not.toContain('template-page-free-run');
        expect(html).not.toContain('<script');
      }
    });

    it('renders the box with its config in data attributes and only the hashed script', () => {
      const html = renderTemplatePage({ ...view, freeRun: open });
      expect(html).toContain('data-testid="template-page-free-run-input"');
      expect(html).toContain('maxlength="8000"');
      expect(html).toContain('data-testid="template-page-free-run-btn">Try it free</button>');
      expect(html).toContain('data-run-url="/api/skills/template/run/article-bullets"');
      expect(html).toContain('data-site-key="site-&quot;key"');
      expect(html).toContain('data-action="skill-free-run"');
      expect(html).toContain('data-input-key="b4m.skillTemplate.freeRunInput.article-bullets"');
      expect(html).toContain(`data-mermaid-src="${MERMAID_SCRIPT_SRC}"`);
      expect(html).toMatch(/data-testid="template-page-free-run-signup" hidden>/);
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      expect(scripts).toHaveLength(1);
      expect(`'sha256-${createHash('sha256').update(scripts[0]).digest('base64')}'`).toBe(
        TEMPLATE_FREE_RUN_SCRIPT_HASH
      );
    });

    it('keeps the script identical across pages so one CSP hash admits it', () => {
      const script = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
      expect(script(renderTemplatePage({ ...view, freeRun: open }))).toBe(
        script(
          renderTemplatePage({
            ...view,
            slug: 'other',
            freeRun: { ...open, siteKey: 'k2', inputMaxChars: 10, file: { maxBytes: 2048 } },
          })
        )
      );
    });

    it('renders the file picker and its cap only when the model takes files', () => {
      const without = renderTemplatePage({ ...view, freeRun: { ...open, file: null } });
      expect(without).not.toContain('template-page-free-run-file');
      expect(without).not.toContain('data-file-max-bytes="');
      const html = renderTemplatePage({ ...view, freeRun: { ...open, file: { maxBytes: 3 * 1024 * 1024 } } });
      expect(html).toContain('data-testid="template-page-free-run-file"');
      expect(html).toContain('<input id="free-run-file" type="file"');
      expect(html).toContain('data-file-max-bytes="3145728"');
      expect(html).toContain('data-file-max-label="3 MB"');
      expect(html).toContain('PDF, image or text, up to 3 MB');
    });

    it('shows the sign-up prompt, linking to the try route, to a visitor who already ran', () => {
      const html = renderTemplatePage({ ...view, freeRun: { state: 'used' } });
      expect(html).toMatch(/data-testid="template-page-free-run-signup">/);
      expect(html).toContain(
        'href="/skills/market/try/article-bullets" data-testid="template-page-free-run-signup-btn"'
      );
      expect(html).not.toContain('template-page-free-run-input');
      expect(html).not.toContain('<script');
    });
  });
});

describe('renderTemplateLoaderShell', () => {
  it('carries no template data and only the script its CSP hash admits', () => {
    const html = renderTemplateLoaderShell('article-bullets');
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(`'sha256-${createHash('sha256').update(script).digest('base64')}'`).toBe(TEMPLATE_LOADER_SCRIPT_HASH);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).not.toMatch(/og:|twitter:/);
  });

  it('sends the no-script sign-in link back to the page after login', () => {
    expect(renderTemplateLoaderShell('article-bullets')).toContain('href="/login?redirectTo=%2Ft%2Farticle-bullets"');
  });
});

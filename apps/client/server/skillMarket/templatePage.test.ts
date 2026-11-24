// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ findOne: vi.fn(), updateOne: vi.fn(), findListing: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  SkillListingTemplate: { findOne: h.findOne, updateOne: h.updateOne },
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ findListing: h.findListing }));
vi.mock('./template', () => ({
  isLive: (l: { status: string; currentApprovedVersionId?: string; hiddenByReports?: boolean }) =>
    l.status === 'approved' && !!l.currentApprovedVersionId && !l.hiddenByReports,
}));

import {
  MERMAID_SCRIPT_SRC,
  TEMPLATE_FREE_RUN_SCRIPT_HASH,
  TEMPLATE_LOADER_SCRIPT_HASH,
  findServableTemplate,
  recordTemplateTry,
  recordTemplateView,
  renderTemplateLoaderShell,
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
  it('increments the view count', async () => {
    h.updateOne.mockResolvedValue({});
    await recordTemplateView({ _id: 't1' } as never);
    expect(h.updateOne).toHaveBeenCalledWith({ _id: 't1' }, { $inc: { viewCount: 1 } }, { runValidators: true });
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

  it('draws required inputs solid and optional ones dashed', () => {
    const html = renderTemplatePage(view);
    expect(html).toContain(
      '<li class="chip" data-testid="template-page-input-chip" data-required="true">An article</li>'
    );
    expect(html).toContain('class="chip optional" data-testid="template-page-input-chip" data-required="false">A tone');
    expect(html).toMatch(/\.chip\.optional\{border-style:dashed/);
  });

  it('leaves out the inputs block when the template lists none', () => {
    expect(renderTemplatePage({ ...view, inputs: [] })).not.toContain('You bring');
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
        script(renderTemplatePage({ ...view, slug: 'other', freeRun: { ...open, siteKey: 'k2', inputMaxChars: 10 } }))
      );
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
    const html = renderTemplateLoaderShell();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(`'sha256-${createHash('sha256').update(script).digest('base64')}'`).toBe(TEMPLATE_LOADER_SCRIPT_HASH);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).not.toMatch(/og:|twitter:/);
  });
});

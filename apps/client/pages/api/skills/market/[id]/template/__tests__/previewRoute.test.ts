// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, skillTemplatePreviewPath } from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({ baseApiOptions: [] as unknown[], findOwn: vi.fn(), build: vi.fn() }));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions.push(options);
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (fn: unknown) => fn;
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ SkillListingTemplate: {} }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ findListing: vi.fn() }));
vi.mock('@server/skillMarket/template', () => ({ isLive: () => true }));
vi.mock('@server/skillMarket/templatePageView', () => ({
  findOwnPreviewTemplate: h.findOwn,
  buildTemplatePageView: h.build,
}));

import handler from '../preview';
import { TEMPLATE_EXAMPLE_SCRIPT_HASH, TEMPLATE_FREE_RUN_SCRIPT_HASH } from '@server/skillMarket/templatePage';

const USER = { id: 'author-1' };
const draft = { _id: 't1', listingId: 'listing-1', slug: 'launch-plan', status: 'draft' };
const listing = { id: 'listing-1', name: 'launch-plan', visibility: 'public' };

const pageView = (over: Record<string, unknown> = {}) => ({
  slug: 'launch-plan',
  skillName: 'launch-plan',
  headline: 'Draft headline',
  inputs: [{ label: 'Your goal', required: true }],
  authorName: 'Ada',
  rating: { sum: 0, count: 0 },
  connectors: [],
  takesFile: false,
  example: {
    prompt: 'Plan it',
    replyHtml: '<p>Plan</p>',
    steps: [],
    artifact: null,
    media: null,
    sampleFile: null,
  },
  imageSrc: null,
  starterCredits: 0,
  brandName: 'Acme',
  share: null,
  freeRun: { state: 'preview' },
  ...over,
});

function call() {
  const { req, res } = createMocks({
    method: 'GET',
    query: { id: 'listing-1' },
    headers: { host: 'localhost:3000', 'x-forwarded-proto': 'https' },
  });
  Object.assign(req, { user: USER, logger: { warn: vi.fn() } });
  return { res, run: () => (handler as unknown as Handler)(req, res) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.findOwn.mockResolvedValue({ template: draft, listing, isPublic: true });
  h.build.mockResolvedValue(pageView());
});

describe('GET /api/skills/market/[id]/template/preview', () => {
  it('is a GET-only, JWT-only route at the shared path', () => {
    expect(h.baseApiOptions).toEqual([{ auth: 'jwtOnly', allowedMethods: ['GET'] }]);
    expect(skillTemplatePreviewPath('listing-1')).toBe('/api/skills/market/listing-1/template/preview');
  });

  it("renders the author's template, draft included, as an inert, uncached, unindexed page", async () => {
    const { res, run } = call();
    await run();
    const html = String(res._getData());

    expect(h.findOwn).toHaveBeenCalledWith(USER, 'listing-1');
    expect(h.build).toHaveBeenCalledWith(
      expect.objectContaining({ template: draft, listing, isPublic: true, preview: true })
    );
    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(res.getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain('Draft headline');
    expect(html).toContain('data-testid="template-page-free-run-preview"');
    expect(html).not.toContain('id="free-run-form"');
    expect(html).not.toMatch(/og:|twitter:/);
  });

  it('admits only the example script and only same-origin framing', async () => {
    const { res, run } = call();
    await run();
    const csp = String(res.getHeader('Content-Security-Policy'));
    const scripts = [...String(res._getData()).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain(`script-src ${TEMPLATE_EXAMPLE_SCRIPT_HASH}`);
    expect(csp).not.toContain(TEMPLATE_FREE_RUN_SCRIPT_HASH);
    expect(scripts.map(s => `'sha256-${createHash('sha256').update(s).digest('base64')}'`)).toEqual([
      TEMPLATE_EXAMPLE_SCRIPT_HASH,
    ]);
  });

  it('renders the single-column page with no script when there is no example', async () => {
    h.build.mockResolvedValue(pageView({ example: null, freeRun: null }));
    const { res, run } = call();
    await run();
    expect(String(res._getData())).not.toContain('<script');
    expect(String(res.getHeader('Content-Security-Policy'))).not.toContain('script-src');
  });

  it('refuses anyone but the author before rendering', async () => {
    h.findOwn.mockRejectedValue(new ForbiddenError("Only the author can manage this listing's template"));
    const { res, run } = call();
    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.build).not.toHaveBeenCalled();
    expect(res._getData()).toBe('');
  });
});

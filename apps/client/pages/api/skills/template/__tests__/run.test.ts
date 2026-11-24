// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Middleware = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

const h = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  uses: [] as unknown[],
  post: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  order: [] as string[],
  policy: vi.fn(),
  checkToken: vi.fn(),
  settings: vi.fn(),
  find: vi.fn(),
  snapshot: vi.fn(),
  used: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  complete: vi.fn(),
  record: vi.fn(),
  accepts: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  chain.use = (fn: unknown) => {
    h.uses.push(fn);
    return chain;
  };
  chain.post = (fn: typeof h.post) => {
    h.post = fn;
    return chain;
  };
  return {
    baseApi: (options: unknown) => {
      h.baseApiOptions.push(options);
      return chain;
    },
  };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: unknown, _res: unknown, next: () => void) => {
    h.order.push('blocked-ip');
    next();
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (opts: { bucket: string }) => (_req: unknown, _res: unknown, next: () => void) => {
    h.order.push(`rate-limit:${opts.bucket}`);
    next();
  },
}));
vi.mock('@server/utils/auth/turnstile', () => ({ getTurnstileFreeRunPolicy: h.policy }));
vi.mock('@server/middlewares/requireTurnstile', () => ({
  checkTurnstileToken: (...args: unknown[]) => {
    h.order.push('turnstile');
    return h.checkToken(...args);
  },
}));
vi.mock('@server/utils/otcLimits', () => ({ ipSubject: () => '2001:db8:1:2::/64' }));
vi.mock('@server/skillMarket/templatePage', () => ({ findServableTemplate: h.find }));
vi.mock('@server/skillMarket/templateImage', () => ({
  isPublicTemplatePage: (listing: { visibility: string }) => ['public', 'unlisted'].includes(listing.visibility),
}));
vi.mock('@server/skillMarket/template', () => ({ approvedSnapshotOf: h.snapshot }));
vi.mock('@server/skillMarket/templateFreeRun', async () => {
  const actual = await vi.importActual<typeof import('@server/skillMarket/templateFreeRun')>(
    '@server/skillMarket/templateFreeRun'
  );
  return {
    buildFreeRunMessages: actual.buildFreeRunMessages,
    FreeRunTimeoutError: actual.FreeRunTimeoutError,
    renderFreeRunResult: actual.renderFreeRunResult,
    freeRunCookieHeader: () => 'b4m_template_free_run=signed; Path=/; HttpOnly',
    hasUsedFreeRun: h.used,
    loadFreeRunSettings: h.settings,
    reserveFreeRunCaps: h.reserve,
    completeFreeRun: h.complete,
    freeRunAcceptsFiles: h.accepts,
    recordTemplateFreeRun: h.record,
  };
});

import { asUpload, makePdf, PNG_1PX } from '@server/skillMarket/templateFreeRunFile.fixtures';
import '../run/[slug]';

const SETTINGS = {
  enabled: true,
  model: 'operations',
  perTemplateDailyCap: 50,
  globalDailyCap: 500,
  inputMaxChars: 100,
  outputMaxTokens: 1500,
  fileMaxMb: 5,
  fileMaxPages: 10,
};

const template = (over: Record<string, unknown> = {}) => ({
  _id: 'tpl-1',
  listingId: 'listing-1',
  slug: 'article-bullets',
  freeRunEnabled: true,
  ...over,
});
const listing = (over: Record<string, unknown> = {}) => ({
  id: 'listing-1',
  name: 'article-bullets',
  visibility: 'public',
  ...over,
});
const snapshot = (over: Record<string, unknown> = {}) => ({
  name: 'article-bullets',
  description: 'Five bullets',
  body: 'Summarize $ARGUMENTS as five bullets.',
  ...over,
});

async function call(
  body: Record<string, unknown> = { text: 'An article.', turnstileToken: 'tok' },
  slug: unknown = 'article-bullets'
) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { slug } as never,
    body,
    headers: { 'x-forwarded-proto': 'https', cookie: 'other=1' },
  });
  Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn() }, requestId: 'req-1' });
  for (const fn of h.uses as Middleware[]) {
    let advanced = false;
    await fn(req, res, err => {
      if (err) throw err;
      advanced = true;
    });
    if (!advanced) return res;
  }
  await h.post!(req, res);
  return res;
}

const json = (res: { _getJSONData: () => unknown }) => res._getJSONData() as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.policy.mockResolvedValue({ active: true, failClosed: true, siteKey: 'site', secret: 'secret' });
  h.checkToken.mockResolvedValue(null);
  h.settings.mockResolvedValue(SETTINGS);
  h.find.mockResolvedValue({ template: template(), listing: listing() });
  h.snapshot.mockResolvedValue({ snapshot: snapshot(), versionId: 'v1' });
  h.used.mockReturnValue(false);
  h.release.mockResolvedValue(undefined);
  h.reserve.mockResolvedValue({ ok: true, release: h.release });
  h.complete.mockResolvedValue('# Bullets\n\n- [ ] one\n- two');
  h.record.mockResolvedValue(undefined);
  h.accepts.mockResolvedValue(true);
});

describe('POST /api/skills/template/run/[slug]', () => {
  it('is an unauthenticated POST-only route', () => {
    expect(h.baseApiOptions).toEqual([{ auth: false, allowedMethods: ['POST'], maxBodySize: expect.any(Number) }]);
  });

  it('checks the blocked IP, then Turnstile, then the rate limit', async () => {
    await call();
    expect(h.order).toEqual(['blocked-ip', 'turnstile', 'rate-limit:skill-template-free-run']);
    expect(h.checkToken).toHaveBeenCalledWith(
      expect.anything(),
      'skill-free-run',
      expect.objectContaining({ active: true }),
      'tok'
    );
  });

  it('runs the approved snapshot once and returns the sanitized result with the one-run cookie', async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({
      html: expect.stringContaining('<h1>Bullets</h1>'),
      hasDiagram: false,
    });
    expect(String(json(res).html)).toContain('<input type="checkbox" />');
    expect(res.getHeader('Set-Cookie')).toContain('b4m_template_free_run=');
    expect(h.complete).toHaveBeenCalledTimes(1);
    const args = h.complete.mock.calls[0][0];
    expect(args).toMatchObject({ model: 'operations', maxTokens: 1500 });
    expect(args.system).toContain('Summarize [the visitor input in the user message] as five bullets.');
    expect(args.system).not.toContain('An article.');
    expect(args.user).toContain('An article.');
    expect(h.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'tpl-1', ipBucket: '2001:db8:1:2::/64', settings: SETTINGS })
    );
    expect(h.record).toHaveBeenCalledWith('tpl-1');
  });

  describe('Turnstile', () => {
    it('refuses with 503 and no model call when Turnstile is off or unconfigured', async () => {
      h.policy.mockResolvedValue({ active: false, failClosed: true, siteKey: '', secret: '' });
      const res = await call();
      expect(res.statusCode).toBe(503);
      expect(json(res).code).toBe('challenge_unavailable');
      expect(h.checkToken).not.toHaveBeenCalled();
      expect(h.complete).not.toHaveBeenCalled();
    });

    it('refuses when the policy cannot be read', async () => {
      h.policy.mockRejectedValue(new Error('db down'));
      const res = await call();
      expect(res.statusCode).toBe(503);
      expect(h.complete).not.toHaveBeenCalled();
    });

    it('refuses a failed challenge with no model call', async () => {
      h.checkToken.mockResolvedValue({ code: 'challenge_failed', status: 403, error: 'Verification failed.' });
      const res = await call();
      expect(res.statusCode).toBe(403);
      expect(json(res).code).toBe('challenge_failed');
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.complete).not.toHaveBeenCalled();
    });
  });

  describe('refusals before any cap is reserved', () => {
    it.each([
      ['free runs are switched off', () => h.settings.mockResolvedValue({ ...SETTINGS, enabled: false }), 403],
      ['the page is not servable (withdrawn, delisted, unpublished)', () => h.find.mockResolvedValue(null), 404],
      [
        'the listing is an organization listing',
        () => h.find.mockResolvedValue({ template: template(), listing: listing({ visibility: 'org' }) }),
        403,
      ],
      [
        'the author did not enable the free run',
        () => h.find.mockResolvedValue({ template: template({ freeRunEnabled: false }), listing: listing() }),
        403,
      ],
      [
        'the approved skill uses tools',
        () => h.snapshot.mockResolvedValue({ snapshot: snapshot({ allowedTools: ['web_search'] }), versionId: 'v1' }),
        403,
      ],
      [
        'the approved skill ships files',
        () =>
          h.snapshot.mockResolvedValue({
            snapshot: snapshot({ files: [{ path: 'a.md', content: 'x' }] }),
            versionId: 'v1',
          }),
        403,
      ],
    ])('refuses when %s', async (_label, arrange, status) => {
      arrange();
      const res = await call();
      expect(res.statusCode).toBe(status);
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.complete).not.toHaveBeenCalled();
    });

    it('404s a malformed slug without a lookup', async () => {
      const res = await call(undefined, '../x');
      expect(res.statusCode).toBe(404);
      expect(h.find).not.toHaveBeenCalled();
    });

    it('answers free_run_used to a visitor who already ran', async () => {
      h.used.mockReturnValue(true);
      const res = await call();
      expect(res.statusCode).toBe(429);
      expect(json(res).code).toBe('free_run_used');
      expect(h.used).toHaveBeenCalledWith('other=1');
      expect(h.complete).not.toHaveBeenCalled();
    });

    it('refuses empty input', async () => {
      const res = await call({ text: '   ', turnstileToken: 'tok' });
      expect(res.statusCode).toBe(400);
      expect(json(res)).toMatchObject({ code: 'input_required', error: 'Paste some text or attach a file to run.' });
    });

    it('refuses input over the admin length cap', async () => {
      const res = await call({ text: 'x'.repeat(101), turnstileToken: 'tok' });
      expect(res.statusCode).toBe(400);
      expect(json(res).code).toBe('input_too_long');
      expect(h.complete).not.toHaveBeenCalled();
    });

    it('accepts input at the cap', async () => {
      const res = await call({ text: 'x'.repeat(100), turnstileToken: 'tok' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('caps', () => {
    it.each(['visitor', 'template', 'global'])(
      'answers free_run_capped with no model call on the %s cap',
      async refusal => {
        h.reserve.mockResolvedValue({ ok: false, refusal });
        const res = await call();
        expect(res.statusCode).toBe(429);
        expect(json(res).code).toBe('free_run_capped');
        expect(h.complete).not.toHaveBeenCalled();
        expect(res.getHeader('Set-Cookie')).toBeUndefined();
      }
    );

    it('releases the reserved caps and sets no cookie when the model call fails', async () => {
      h.complete.mockRejectedValue(new Error('provider down'));
      const res = await call();
      expect(res.statusCode).toBe(502);
      expect(json(res).code).toBe('free_run_failed');
      expect(h.release).toHaveBeenCalledTimes(1);
      expect(h.record).not.toHaveBeenCalled();
      expect(res.getHeader('Set-Cookie')).toBeUndefined();
    });

    it('keeps the caps spent when the run times out, since the provider call may still bill', async () => {
      const { FreeRunTimeoutError } = await import('@server/skillMarket/templateFreeRun');
      h.complete.mockRejectedValue(new FreeRunTimeoutError('Free run timed out'));
      const res = await call();
      expect(res.statusCode).toBe(502);
      expect(h.release).not.toHaveBeenCalled();
      expect(res.getHeader('Set-Cookie')).toBeUndefined();
    });

    it('passes the admin output cap and model to the completion', async () => {
      h.settings.mockResolvedValue({ ...SETTINGS, model: 'gpt-4.1-mini', outputMaxTokens: 300 });
      await call();
      expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4.1-mini', maxTokens: 300 }));
    });
  });

  describe('attached file', () => {
    const pdf = (pages: number) =>
      asUpload(makePdf(Array.from({ length: pages }, (_, i) => `Page ${i + 1} text`)), 'brief.pdf', 'application/pdf');
    const expectNoRun = () => {
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.complete).not.toHaveBeenCalled();
    };

    it('takes a body large enough for the biggest file once base64-encoded', async () => {
      const { config } = await import('../run/[slug]');
      const { FREE_RUN_BODY_MAX_BYTES, FREE_RUN_FILE_TRANSPORT_MAX_BYTES } =
        await import('@server/skillMarket/templateFreeRunFile');
      expect(FREE_RUN_BODY_MAX_BYTES).toBeGreaterThan((FREE_RUN_FILE_TRANSPORT_MAX_BYTES * 4) / 3);
      expect(h.baseApiOptions).toEqual([expect.objectContaining({ maxBodySize: FREE_RUN_BODY_MAX_BYTES })]);
      expect(config.api.bodyParser.sizeLimit).toBe('6mb');
      expect(FREE_RUN_BODY_MAX_BYTES).toBeLessThanOrEqual(6 * 1024 * 1024);
    });

    it('runs a PDF with no pasted text, its text inside the visitor block', async () => {
      const res = await call({ turnstileToken: 'tok', file: pdf(2) });
      expect(res.statusCode).toBe(200);
      const args = h.complete.mock.calls[0][0];
      expect(args.user).toMatch(
        /BEGIN VISITOR INPUT[\s\S]*\[Attached file "brief\.pdf"\][\s\S]*Page 1 text[\s\S]*END VISITOR/
      );
      expect(args.image).toBeUndefined();
      expect(h.accepts).toHaveBeenCalledWith('operations', expect.anything());
      expect(res.getHeader('Set-Cookie')).toContain('b4m_template_free_run=');
    });

    it('sends an image to the model as an image next to the pasted text', async () => {
      const res = await call({
        text: 'What is this?',
        turnstileToken: 'tok',
        file: asUpload(PNG_1PX, 'a.png', 'image/png'),
      });
      expect(res.statusCode).toBe(200);
      const args = h.complete.mock.calls[0][0];
      expect(args.image).toBe(`data:image/png;base64,${PNG_1PX.toString('base64')}`);
      expect(args.user).toContain('What is this?');
      expect(args.user).toContain('[Attached image "a.png", sent with this message]');
    });

    it('refuses a second file with no model call', async () => {
      const res = await call({ text: 'x', turnstileToken: 'tok', file: [pdf(1), pdf(1)] });
      expect(res.statusCode).toBe(400);
      expect(json(res).code).toBe('too_many_files');
      expectNoRun();
    });

    it('refuses a file over the admin size cap with no model call', async () => {
      h.settings.mockResolvedValue({ ...SETTINGS, fileMaxMb: 0.001 });
      const res = await call({
        turnstileToken: 'tok',
        file: asUpload(Buffer.alloc(2048, 0x61), 'a.txt', 'text/plain'),
      });
      expect(res.statusCode).toBe(413);
      expect(json(res)).toMatchObject({ code: 'file_too_large', error: 'Attach a file under 1 KB.' });
      expectNoRun();
    });

    it('refuses a PDF over the admin page cap with no model call', async () => {
      h.settings.mockResolvedValue({ ...SETTINGS, fileMaxPages: 2 });
      const res = await call({ turnstileToken: 'tok', file: pdf(3) });
      expect(res.statusCode).toBe(400);
      expect(json(res)).toMatchObject({ code: 'file_too_many_pages', error: 'Attach a PDF of 2 pages or fewer.' });
      expectNoRun();
    });

    it('applies a changed page cap on the next run', async () => {
      h.settings.mockResolvedValue({ ...SETTINGS, fileMaxPages: 2 });
      expect((await call({ turnstileToken: 'tok', file: pdf(3) })).statusCode).toBe(400);
      h.settings.mockResolvedValue({ ...SETTINGS, fileMaxPages: 3 });
      expect((await call({ turnstileToken: 'tok', file: pdf(3) })).statusCode).toBe(200);
      expect(h.settings).toHaveBeenCalledTimes(2);
    });

    it('applies a changed size cap on the next run', async () => {
      const file = asUpload(Buffer.alloc(2048, 0x61), 'a.txt', 'text/plain');
      h.settings.mockResolvedValue({ ...SETTINGS, fileMaxMb: 0.001 });
      expect((await call({ turnstileToken: 'tok', file })).statusCode).toBe(413);
      h.settings.mockResolvedValue({ ...SETTINGS, fileMaxMb: 1 });
      expect((await call({ turnstileToken: 'tok', file })).statusCode).toBe(200);
    });

    it('refuses any file when the model takes none, and still runs text alone', async () => {
      h.accepts.mockResolvedValue(false);
      const res = await call({ text: 'x', turnstileToken: 'tok', file: asUpload(PNG_1PX, 'a.png', 'image/png') });
      expect(res.statusCode).toBe(400);
      expect(json(res).code).toBe('file_not_supported');
      expectNoRun();
      expect((await call()).statusCode).toBe(200);
      expect(h.accepts).toHaveBeenCalledTimes(1);
    });

    it('refuses an unsupported file type with no model call', async () => {
      const res = await call({
        turnstileToken: 'tok',
        file: asUpload(Buffer.from([0, 1, 2, 3]), 'a.zip', 'application/zip'),
      });
      expect(res.statusCode).toBe(400);
      expect(json(res).code).toBe('file_type_unsupported');
      expectNoRun();
    });

    it('counts the run on the template and stores nothing of the file', async () => {
      await call({ turnstileToken: 'tok', file: pdf(1) });
      expect(h.record).toHaveBeenCalledWith('tpl-1');
      expect(h.record.mock.calls[0]).toHaveLength(1);
    });
  });
});

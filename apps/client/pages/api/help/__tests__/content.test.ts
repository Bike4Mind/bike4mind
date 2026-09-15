import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { capturedOptions } = vi.hoisted(() => ({ capturedOptions: { value: undefined as unknown } }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    capturedOptions.value = options;
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

import { ApiKeyScope } from '@bike4mind/common';

import handler from '../content';

const ADMIN_MARKDOWN = '---\ntitle: Admin Overview\naccessLevel: admin\n---\n\n# Admin Overview\n\nSecret runbook.\n';
/** A tiny non-UTF8 payload, so a byte-for-byte assertion actually means bytes. */
const ADMIN_IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
const SHARED_IMAGE = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0xfd]);
const PUBLIC_MARKDOWN = '# Public Guide\n\nPUBLIC_MARKDOWN_MARKER\n';
const INDEX_MARKER = 'HELP_INDEX_SHOULD_NEVER_BE_SERVED_HERE';
const ESCAPED_MARKER = 'OUTSIDE_ADMIN_ROOT_MARKER';

let tmpDir: string;
let adminRoot: string;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const run = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).logger = logger;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const bodyText = (res: ReturnType<typeof createMocks>['res']): string => {
  const raw = res._getData() as unknown;
  if (Buffer.isBuffer(raw)) return raw.toString('utf-8');
  if (typeof raw === 'string') return raw;
  return JSON.stringify(raw ?? null);
};

const header = (res: ReturnType<typeof createMocks>['res'], name: string) => res.getHeader(name);

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'help-content-route-'));
  adminRoot = path.join(tmpDir, 'app/generated/help-content-admin');
  fs.mkdirSync(path.join(adminRoot, 'admin/media'), { recursive: true });
  fs.writeFileSync(path.join(adminRoot, 'admin/overview.md'), ADMIN_MARKDOWN, 'utf-8');
  fs.writeFileSync(path.join(adminRoot, 'admin/media/setup.png'), ADMIN_IMAGE);
  // An extension outside the allowlist, sitting inside the admin root.
  fs.writeFileSync(path.join(adminRoot, 'admin/notes.json'), '{"secret":true}', 'utf-8');
  // The traversal targets: real files one level above the admin root. The `.md` one has an
  // ALLOWED extension, so only the traversal guard stands between it and the caller.
  fs.writeFileSync(path.join(tmpDir, 'app/generated/help-index.json'), `{"marker":"${INDEX_MARKER}"}`, 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'app/generated/escaped.md'), `# ${ESCAPED_MARKER}\n`, 'utf-8');

  // Public root: an asset the bundler put here only ("public wins"), plus public markdown.
  const publicRoot = path.join(tmpDir, 'public/help-content');
  fs.mkdirSync(path.join(publicRoot, 'guides/media'), { recursive: true });
  fs.writeFileSync(path.join(publicRoot, 'guides/media/shared.gif'), SHARED_IMAGE);
  fs.writeFileSync(path.join(publicRoot, 'guides/widget.md'), PUBLIC_MARKDOWN, 'utf-8');

  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  logger.warn.mockReset();
});

describe('GET /api/help/content', () => {
  it('keeps the api-key path behind the ADMIN scope', () => {
    // Without this an admin's narrowly-scoped integration key would read platform admin docs.
    expect(capturedOptions.value).toEqual({ requiredScopes: [ApiKeyScope.ADMIN] });
  });

  it('serves an admin markdown body verbatim to an admin caller', async () => {
    const { res, promise } = run({ path: 'admin/overview.md' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // Verbatim, frontmatter included - the client strips it, so stripping here would double up.
    expect(bodyText(res)).toBe(ADMIN_MARKDOWN);
    expect(header(res, 'Content-Type')).toBe('text/markdown; charset=utf-8');
  });

  it('serves referenced admin media with its own content type, byte for byte', async () => {
    const { res, promise } = run({ path: 'admin/media/setup.png' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(Buffer.isBuffer(res._getData())).toBe(true);
    expect((res._getData() as unknown as Buffer).equals(ADMIN_IMAGE)).toBe(true);
    expect(header(res, 'Content-Type')).toBe('image/png');
  });

  it('marks the response uncacheable and auth-varying', async () => {
    const { res, promise } = run({ path: 'admin/overview.md' });
    await promise;

    expect(header(res, 'Cache-Control')).toBe('private, no-store');
    expect(header(res, 'Vary')).toBe('Authorization');
    expect(header(res, 'X-Content-Type-Options')).toBe('nosniff');
  });

  it('falls back to the public root for an asset an admin article shares with a public one', async () => {
    // The bundler writes an asset referenced by any public article to the public root ONLY
    // ("public wins"), so an admin article can reference media that is not under the admin root.
    // No exposure: Next already serves the public root unauthenticated.
    const { res, promise } = run({ path: 'guides/media/shared.gif' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect((res._getData() as unknown as Buffer).equals(SHARED_IMAGE)).toBe(true);
    expect(header(res, 'Content-Type')).toBe('image/gif');
  });

  it('does not fall back to the public root for markdown', async () => {
    // Public markdown is already a static asset; pulling it through the authed route would widen
    // this route's reach for nothing.
    const { res, promise } = run({ path: 'guides/widget.md' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(bodyText(res)).not.toContain('PUBLIC_MARKDOWN_MARKER');
  });

  it('404s an authenticated non-admin caller rather than 403ing it', async () => {
    // 403 would confirm the article exists to anyone who can guess a slug; 404 gives no oracle.
    const { res, promise } = run({ path: 'admin/overview.md' }, { id: 'u2', isAdmin: false });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(bodyText(res)).not.toContain('Secret runbook');
  });

  it('404s a caller with no session', async () => {
    // In production baseApi's auth chain 401s before the handler runs (auth defaults to true), so
    // this asserts the handler's own fail-closed behaviour on a req that carries no user.
    const { res, promise } = run({ path: 'admin/overview.md' }, null);
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(bodyText(res)).not.toContain('Secret runbook');
  });

  it('404s a traversal attempt instead of reaching outside the admin root', async () => {
    const { res, promise } = run({ path: '../../generated/help-index.json' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(bodyText(res)).not.toContain(INDEX_MARKER);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Path traversal attempt blocked'));
  });

  it('404s a traversal to a file whose extension the allowlist would have accepted', async () => {
    // The allowlist is not what stops this one - the traversal guard is the only thing in the way.
    const { res, promise } = run({ path: '../escaped.md' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(bodyText(res)).not.toContain(ESCAPED_MARKER);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Path traversal attempt blocked'));
  });

  it('404s an absolute path', async () => {
    const { res, promise } = run({ path: path.join(adminRoot, 'admin/overview.md') });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(bodyText(res)).not.toContain('Secret runbook');
  });

  it('404s an extension outside the allowlist even when the file exists', async () => {
    // The root sits inside the deployed app directory, so an unknown type must be a miss rather
    // than an octet-stream download of whatever happens to be there.
    const { res, promise } = run({ path: 'admin/notes.json' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(bodyText(res)).not.toContain('secret');
  });

  it('404s a missing file and a missing path parameter', async () => {
    const missing = run({ path: 'admin/nope.md' });
    await missing.promise;
    expect(missing.res._getStatusCode()).toBe(404);

    const noParam = run({});
    await noParam.promise;
    expect(noParam.res._getStatusCode()).toBe(404);
  });

  it('404s rather than 500s when no admin content is bundled at all', async () => {
    const emptyDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'help-content-empty-'));
    vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
    try {
      const { res, promise } = run({ path: 'admin/overview.md' });
      await promise;
      expect(res._getStatusCode()).toBe(404);
    } finally {
      vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

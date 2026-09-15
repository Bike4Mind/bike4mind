import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadHelpContent, searchHelpContext } from './retrieval';

/**
 * Access-level isolation of help article BODIES. The index filter (`filterHelpIndex` in
 * `pages/api/help/index.ts`, `findRelevantHelpEntries` here) decides which slugs a caller may see;
 * these tests cover the layer under it - what `loadHelpContent` will read off disk, and the
 * module-level cache it reads through.
 */

const ADMIN_BODY = '# Widget Runbook\n\nADMIN_ONLY_BODY_MARKER\n';
const PUBLIC_BODY = '# Widget Guide\n\nPUBLIC_BODY_MARKER\n';
const OUTSIDE_BODY = 'OUTSIDE_ROOT_MARKER\n';

let tmpDir: string;
let publicRoot: string;
let adminRoot: string;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const writeFile = (absPath: string, content: string) => {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
};

const helpIndex = {
  version: 'test',
  categories: [],
  entries: [
    {
      slug: 'admin/runbook',
      title: 'Widget Runbook',
      description: 'Admin widget runbook',
      category: 'admin',
      sidebarPosition: 1,
      tags: ['widget'],
      headings: [],
      filePath: 'admin/runbook.md',
      accessLevel: 'admin',
    },
    {
      slug: 'guides/widget',
      title: 'Widget Guide',
      description: 'Public widget guide',
      category: 'guides',
      sidebarPosition: 1,
      tags: ['widget'],
      headings: [],
      filePath: 'guides/widget.md',
      accessLevel: 'public',
    },
  ],
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'help-retrieval-'));
  publicRoot = path.join(tmpDir, 'public/help-content');
  adminRoot = path.join(tmpDir, 'app/generated/help-content-admin');

  writeFile(path.join(adminRoot, 'admin/secret-a.md'), ADMIN_BODY);
  writeFile(path.join(adminRoot, 'admin/secret-b.md'), ADMIN_BODY);
  writeFile(path.join(adminRoot, 'admin/nested/index.md'), ADMIN_BODY);
  writeFile(path.join(adminRoot, 'admin/runbook.md'), ADMIN_BODY);
  writeFile(path.join(publicRoot, 'guides/widget.md'), PUBLIC_BODY);
  writeFile(path.join(publicRoot, 'guides/evictable.md'), PUBLIC_BODY);
  // One level above the public root, so a `..` slug that escaped would find a real file.
  writeFile(path.join(tmpDir, 'public/outside.md'), OUTSIDE_BODY);
  writeFile(path.join(tmpDir, 'app/generated/help-index.json'), JSON.stringify(helpIndex));

  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  logger.warn.mockReset();
  logger.info.mockReset();
});

describe('loadHelpContent', () => {
  it('does not hand an admin body to a non-admin caller out of the warmed cache', async () => {
    // THE regression this cache key exists for. The cache is module-level and lives for the
    // process, so with a slug-only key the first admin request would leave the admin body sitting
    // there for every later non-admin request for the same slug.
    expect(await loadHelpContent('admin/secret-a', true, logger)).toBe(ADMIN_BODY);
    expect(await loadHelpContent('admin/secret-a', false, logger)).toBeNull();
  });

  it('does not let a non-admin miss get cached as a miss for an admin caller', async () => {
    // The same key collision in the other direction: a negative result cached under a bare slug
    // would make the admin body permanently unreachable for the rest of the process.
    expect(await loadHelpContent('admin/secret-b', false, logger)).toBeNull();
    expect(await loadHelpContent('admin/secret-b', true, logger)).toBe(ADMIN_BODY);
  });

  it('reads public content for either access level', async () => {
    expect(await loadHelpContent('guides/widget', false, logger)).toBe(PUBLIC_BODY);
    expect(await loadHelpContent('guides/widget', true, logger)).toBe(PUBLIC_BODY);
  });

  it('falls back to ${slug}/index.md in the admin root', async () => {
    expect(await loadHelpContent('admin/nested', true, logger)).toBe(ADMIN_BODY);
  });

  it('blocks a slug that escapes a content root', async () => {
    expect(await loadHelpContent('../outside', true, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Path traversal attempt blocked'));
  });

  it('caches a hit and a miss for the lifetime of the process', async () => {
    const cached = path.join(publicRoot, 'guides/evictable.md');
    expect(await loadHelpContent('guides/evictable', false, logger)).toBe(PUBLIC_BODY);
    fs.rmSync(cached);
    expect(await loadHelpContent('guides/evictable', false, logger)).toBe(PUBLIC_BODY);

    const created = path.join(publicRoot, 'guides/late.md');
    expect(await loadHelpContent('guides/late', false, logger)).toBeNull();
    writeFile(created, PUBLIC_BODY);
    expect(await loadHelpContent('guides/late', false, logger)).toBeNull();
  });
});

describe('searchHelpContext keyword fallback', () => {
  // No app/generated/help-embeddings.json in the fixture, so retrieval takes the keyword path -
  // the second of the two call sites that has to thread the caller's access level down to
  // loadHelpContent. Isolation here comes from the index filter; the cache key is covered above.
  const search = (isAdmin: boolean) =>
    searchHelpContext({ question: 'how do I configure the widget', isAdmin, apiKeys: null, logger });

  it('includes an admin article body for an admin asker', async () => {
    const result = await search(true);
    expect(result.method).toBe('keyword');
    expect(result.context).toContain('ADMIN_ONLY_BODY_MARKER');
    expect(result.relevantArticles.map(a => a.slug)).toContain('admin/runbook');
  });

  it('withholds the admin article body from a non-admin asker', async () => {
    const result = await search(false);
    expect(result.context).toContain('PUBLIC_BODY_MARKER');
    expect(result.context).not.toContain('ADMIN_ONLY_BODY_MARKER');
    expect(result.relevantArticles.map(a => a.slug)).not.toContain('admin/runbook');
  });
});

describe('searchHelpContext currentHelpSlug', () => {
  // currentHelpSlug is caller-supplied (pages/api/help/chat.ts) and was looked up against the
  // UNFILTERED index, so a non-admin could name an admin slug and get its metadata back even
  // though findRelevantHelpEntries had correctly excluded it. No body or media leaks - the admin
  // root is not in helpContentRoots(false) - but that is exactly why the metadata did: with a
  // null body, buildKeywordContext emits the title and falls back to the description.
  const viewing = (question: string, isAdmin: boolean) =>
    searchHelpContext({ question, currentHelpSlug: 'admin/runbook', isAdmin, apiKeys: null, logger });

  it('withholds an admin title and description from a non-admin naming the slug', async () => {
    // A question that matches the PUBLIC article, so the keyword path demonstrably ran and the
    // absence below is exclusion rather than an empty context.
    const result = await viewing('how do I configure the widget', false);
    expect(result.context).toContain('PUBLIC_BODY_MARKER');
    expect(result.context).not.toContain('Widget Runbook');
    expect(result.context).not.toContain('Admin widget runbook');
    expect(result.relevantArticles.map(a => a.slug)).not.toContain('admin/runbook');
  });

  it('still prioritises the viewed article for an admin', async () => {
    // A question matching NOTHING, so currentHelpSlug is the only thing that can surface the
    // entry - which is what keeps the access check from being a silent feature removal.
    const result = await viewing('zzz nonmatching interrogative zzz', true);
    expect(result.relevantArticles.map(a => a.slug)).toContain('admin/runbook');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HelpAccessLevel } from '../types';
import { bundleHelpContent } from '../bundle-help-content';
import { MEDIA_SIZE_LIMITS } from '../validate-help-content';

/**
 * Fixture-driven test of the bundler against a temp docs tree: article copies,
 * referenced-asset copies, the accessLevel split across the two output roots, and
 * the stale sweep when references or access levels change.
 */

let root: string;

const docsRoot = () => path.join(root, 'docs');
const outputDir = () => path.join(root, 'out');
const adminOutputDir = () => path.join(root, 'out-admin');
const indexPath = () => path.join(root, 'help-index.json');
// adminOutputDir is always injected: without it the bundler would sweep the real
// repo's admin root while these tests run.
const opts = () => ({
  docsRoot: docsRoot(),
  outputDir: outputDir(),
  adminOutputDir: adminOutputDir(),
  indexPath: indexPath(),
});

function write(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function writeArticle(relPath: string, content: string): void {
  write(path.join(docsRoot(), relPath), content);
}

/** A bare string is an entry with no accessLevel at all, which the bundler treats as public. */
type IndexEntryInput = string | { filePath: string; accessLevel: HelpAccessLevel };

function writeIndex(entries: IndexEntryInput[]): void {
  write(
    indexPath(),
    JSON.stringify({
      entries: entries.map(entry => (typeof entry === 'string' ? { filePath: entry } : entry)),
    })
  );
}

const outFile = (relPath: string) => path.join(outputDir(), relPath);
const adminFile = (relPath: string) => path.join(adminOutputDir(), relPath);

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'help-bundle-test-'));
  // The bundler narrates every copy; keep test output quiet.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('bundleHelpContent', () => {
  it('copies indexed articles and the media they reference', async () => {
    writeArticle('features/a.md', '# A\n\n![Demo](./media/demo.gif)\n');
    writeArticle('features/media/demo.gif', 'gif-bytes');
    writeIndex(['features/a.md']);

    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('features/a.md'))).toBe(true);
    expect(fs.readFileSync(outFile('features/media/demo.gif'), 'utf-8')).toBe('gif-bytes');
  });

  it('resolves absolute and parent-relative asset references against the docs root', async () => {
    writeArticle('features/sub/a.md', '![x](../shared.png)\n![y](/images/logo.png)\n');
    writeArticle('features/shared.png', 'png1');
    writeArticle('images/logo.png', 'png2');
    writeIndex(['features/sub/a.md']);

    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('features/shared.png'))).toBe(true);
    expect(fs.existsSync(outFile('images/logo.png'))).toBe(true);
  });

  it('skips external, missing, and docs-tree-escaping references', async () => {
    write(path.join(root, 'outside.png'), 'secret');
    writeArticle(
      'features/a.md',
      ['![ext](https://example.com/x.gif)', '![gone](./media/missing.gif)', '![escape](../../outside.png)'].join('\n')
    );
    writeIndex(['features/a.md']);

    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('features/a.md'))).toBe(true);
    // Only the article lands in the output tree - none of the bad refs do.
    const outputs: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else outputs.push(path.relative(outputDir(), full));
      }
    };
    walk(outputDir());
    expect(outputs).toEqual(['features/a.md']);
  });

  it('sweeps a bundled asset once no article references it', async () => {
    writeArticle('features/a.md', '![Demo](./media/demo.gif)\n');
    writeArticle('features/media/demo.gif', 'gif-bytes');
    writeIndex(['features/a.md']);
    await bundleHelpContent(opts());
    expect(fs.existsSync(outFile('features/media/demo.gif'))).toBe(true);

    writeArticle('features/a.md', '# No more demo\n');
    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('features/a.md'))).toBe(true);
    expect(fs.existsSync(outFile('features/media/demo.gif'))).toBe(false);
    // The emptied media directory is pruned too.
    expect(fs.existsSync(path.dirname(outFile('features/media/demo.gif')))).toBe(false);
  });

  it('refuses to bundle an asset over its size cap', async () => {
    writeArticle('features/a.md', '![Demo](./media/demo.gif)\n');
    write(path.join(docsRoot(), 'features/media/demo.gif'), 'x'.repeat(MEDIA_SIZE_LIMITS.gif.maxBytes + 1));
    writeIndex(['features/a.md']);

    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('features/a.md'))).toBe(true);
    expect(fs.existsSync(outFile('features/media/demo.gif'))).toBe(false);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('gif cap');
  });

  it('refuses to bundle an embed whose format is not on the allowlist', async () => {
    writeArticle('features/a.md', '![Demo](./media/demo.mpg)\n');
    writeArticle('features/media/demo.mpg', 'mpeg-bytes');
    writeIndex(['features/a.md']);

    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('features/a.md'))).toBe(true);
    expect(fs.existsSync(outFile('features/media/demo.mpg'))).toBe(false);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('Unsupported embed format');
  });

  it('throws when the help index is missing', async () => {
    await expect(bundleHelpContent(opts())).rejects.toThrow('help-index.json not found');
  });
});

/**
 * The public root is served as unauthenticated static assets, so these cases are the
 * guard against admin-only documentation becoming world-readable.
 */
describe('bundleHelpContent access-level split', () => {
  it('bundles a public entry into the public root only', async () => {
    writeArticle('features/a.md', '# A\n');
    writeIndex([{ filePath: 'features/a.md', accessLevel: 'public' }]);

    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('features/a.md'))).toBe(true);
    expect(fs.existsSync(adminFile('features/a.md'))).toBe(false);
  });

  it('bundles an admin entry into the admin root only', async () => {
    writeArticle('admin/overview.md', '# Admin\n');
    writeIndex([{ filePath: 'admin/overview.md', accessLevel: 'admin' }]);

    await bundleHelpContent(opts());

    expect(fs.readFileSync(adminFile('admin/overview.md'), 'utf-8')).toBe('# Admin\n');
    expect(fs.existsSync(outFile('admin/overview.md'))).toBe(false);
  });

  it('routes an unrecognised access level to the admin root, not the public one', async () => {
    // Pins the DIRECTION of the predicate, which the 'public'/'admin' cases alone do not: written
    // as `accessLevel !== 'admin'` every case above still passes, while a value added to
    // HelpAccessLevel later would be published as unauthenticated static content.
    writeArticle('admin/future.md', '# Future\n');
    writeArticle('admin/media/future.png', 'png-bytes');
    writeIndex([{ filePath: 'admin/future.md', accessLevel: 'internal' as HelpAccessLevel }]);

    await bundleHelpContent(opts());

    expect(fs.existsSync(adminFile('admin/future.md'))).toBe(true);
    expect(fs.existsSync(outFile('admin/future.md'))).toBe(false);
  });

  it('leaves no admin root behind for an all-public corpus', async () => {
    writeArticle('features/a.md', '# A\n');
    writeIndex(['features/a.md']);

    await bundleHelpContent(opts());

    expect(fs.existsSync(adminOutputDir())).toBe(false);
  });

  it('keeps an asset only admin articles reference out of the public root', async () => {
    writeArticle('admin/overview.md', '![Secret](./media/secret.png)\n');
    writeArticle('admin/media/secret.png', 'png-bytes');
    writeIndex([{ filePath: 'admin/overview.md', accessLevel: 'admin' }]);

    await bundleHelpContent(opts());

    expect(fs.readFileSync(adminFile('admin/media/secret.png'), 'utf-8')).toBe('png-bytes');
    expect(fs.existsSync(outFile('admin/media/secret.png'))).toBe(false);
  });

  it('bundles a shared asset into the public root only, whichever article is indexed first', async () => {
    writeArticle('features/a.md', '![Shared](/images/shared.png)\n');
    writeArticle('admin/overview.md', '![Shared](/images/shared.png)\n');
    writeArticle('images/shared.png', 'png-bytes');
    // Admin first: the public reference has to win even though the admin one is seen first.
    writeIndex([
      { filePath: 'admin/overview.md', accessLevel: 'admin' },
      { filePath: 'features/a.md', accessLevel: 'public' },
    ]);

    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('images/shared.png'))).toBe(true);
    expect(fs.existsSync(adminFile('images/shared.png'))).toBe(false);
  });

  it('bundles a shared asset into the public root only when the public article is indexed first', async () => {
    writeArticle('features/a.md', '![Shared](/images/shared.png)\n');
    writeArticle('admin/overview.md', '![Shared](/images/shared.png)\n');
    writeArticle('images/shared.png', 'png-bytes');
    writeIndex([
      { filePath: 'features/a.md', accessLevel: 'public' },
      { filePath: 'admin/overview.md', accessLevel: 'admin' },
    ]);

    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('images/shared.png'))).toBe(true);
    expect(fs.existsSync(adminFile('images/shared.png'))).toBe(false);
  });

  it('sweeps the stale public copy when an entry flips to admin', async () => {
    writeArticle('features/a.md', '![Demo](./media/demo.gif)\n');
    writeArticle('features/media/demo.gif', 'gif-bytes');
    writeIndex(['features/a.md']);
    await bundleHelpContent(opts());
    expect(fs.existsSync(outFile('features/a.md'))).toBe(true);

    writeIndex([{ filePath: 'features/a.md', accessLevel: 'admin' }]);
    await bundleHelpContent(opts());

    expect(fs.existsSync(outFile('features/a.md'))).toBe(false);
    expect(fs.existsSync(outFile('features/media/demo.gif'))).toBe(false);
    expect(fs.existsSync(adminFile('features/a.md'))).toBe(true);
    expect(fs.existsSync(adminFile('features/media/demo.gif'))).toBe(true);
  });

  it('sweeps the stale admin copy when an entry flips to public', async () => {
    writeArticle('admin/overview.md', '# Admin\n');
    writeIndex([{ filePath: 'admin/overview.md', accessLevel: 'admin' }]);
    await bundleHelpContent(opts());
    expect(fs.existsSync(adminFile('admin/overview.md'))).toBe(true);

    writeIndex([{ filePath: 'admin/overview.md', accessLevel: 'public' }]);
    await bundleHelpContent(opts());

    expect(fs.existsSync(adminFile('admin/overview.md'))).toBe(false);
    expect(fs.existsSync(outFile('admin/overview.md'))).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bundleHelpContent } from '../bundle-help-content';

/**
 * Fixture-driven test of the bundler against a temp docs tree: article copies,
 * referenced-asset copies, and the stale sweep when references disappear.
 */

let root: string;

const docsRoot = () => path.join(root, 'docs');
const outputDir = () => path.join(root, 'out');
const indexPath = () => path.join(root, 'help-index.json');
const opts = () => ({ docsRoot: docsRoot(), outputDir: outputDir(), indexPath: indexPath() });

function write(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function writeArticle(relPath: string, content: string): void {
  write(path.join(docsRoot(), relPath), content);
}

function writeIndex(filePaths: string[]): void {
  write(indexPath(), JSON.stringify({ entries: filePaths.map(filePath => ({ filePath })) }));
}

const outFile = (relPath: string) => path.join(outputDir(), relPath);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'help-bundle-test-'));
  // The bundler narrates every copy; keep test output quiet.
  vi.spyOn(console, 'log').mockImplementation(() => {});
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

  it('throws when the help index is missing', async () => {
    await expect(bundleHelpContent(opts())).rejects.toThrow('help-index.json not found');
  });
});

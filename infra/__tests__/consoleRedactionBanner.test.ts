/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { consoleRedactionBanner } from '../consoleRedactionBanner';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// sst.config.ts only loads inside `sst`, so its wiring is asserted against the source text.
const sstConfig = readFileSync(path.join(REPO_ROOT, 'sst.config.ts'), 'utf8');

describe('consoleRedactionBanner', () => {
  const banner = consoleRedactionBanner(REPO_ROOT);

  it('is a self-contained script with no module imports', () => {
    expect(banner).not.toMatch(/\brequire\(|^\s*import\s/m);
  });

  it('wraps the console it runs against', () => {
    const log = vi.fn();
    const error = vi.fn();
    const fakeConsole = {
      log,
      info: vi.fn(),
      warn: vi.fn(),
      error,
      debug: vi.fn(),
      trace: vi.fn(),
      dir: vi.fn(),
      table: vi.fn(),
    };
    runInNewContext(banner, { console: fakeConsole, Buffer });

    fakeConsole.error('send failed for', 'jane@example.com', { otc: '123456' });
    expect(error).toHaveBeenCalledWith('send failed for', '***@example.com', { otc: '[REDACTED]' });
  });
});

describe('sst.config.ts wiring', () => {
  it('ships the shim as nodejs.banner, not as an esbuild inject', () => {
    // SST's Function builder drops esbuild `inject` without an error, so an inject never reaches the bundle.
    expect(sstConfig).toContain('consoleRedactionBanner($cli.paths.root)');
    expect(sstConfig).toMatch(/return \{ \.\.\.nodejs, banner,/);
    expect(sstConfig).not.toMatch(/\binject\b/);
  });
});

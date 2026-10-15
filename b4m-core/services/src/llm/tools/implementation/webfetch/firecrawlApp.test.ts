import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import FirecrawlDefault from '@mendable/firecrawl-js';
import { FirecrawlApp, resolveFirecrawlApp, createFirecrawlApp } from './firecrawlApp';
import { UnsafeScrapeTargetError } from './errors';

const requireCjs = createRequire(import.meta.url);

// The guard resolves hostnames; default to a public IP so only the tests that opt in touch DNS.
const dnsLookup = vi.hoisted(() => vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]));
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => dnsLookup(...args) }));

describe('resolveFirecrawlApp', () => {
  it('resolves the constructor from the CJS exports object (rolldown node-mode interop)', () => {
    // In the built .cjs dist, rolldown compiles `import FirecrawlApp from '@mendable/firecrawl-js'`
    // to `__toESM(require(...), 1)` - node-mode interop, which binds the default import to the
    // package's entire module.exports ({ __esModule, default: class, ... }), not the class.
    const cjsExports = requireCjs('@mendable/firecrawl-js');

    // The failure mode: constructing the raw binding throws "is not a constructor".
    expect(() => new cjsExports({ apiKey: 'test-key' })).toThrow(TypeError);

    const Ctor = resolveFirecrawlApp(cjsExports);
    const app = new Ctor({ apiKey: 'test-key' });
    expect(typeof app.scrapeUrl).toBe('function');
    expect(typeof app.search).toBe('function');
  });

  it('passes the constructor through unchanged when the binding is already the class', () => {
    const Ctor = resolveFirecrawlApp(FirecrawlDefault);
    const app = new Ctor({ apiKey: 'test-key' });
    expect(typeof app.scrapeUrl).toBe('function');
  });

  it('exports a constructable FirecrawlApp in the current module regime', () => {
    const app = new FirecrawlApp({ apiKey: 'test-key' });
    expect(typeof app.scrapeUrl).toBe('function');
  });
});

describe('createFirecrawlApp', () => {
  it('returns null when neither apiKey nor apiUrl is configured', () => {
    expect(createFirecrawlApp({})).toBeNull();
  });

  it('constructs an app from an API key (hosted cloud)', () => {
    const app = createFirecrawlApp({ apiKey: 'test-key' });
    expect(app).not.toBeNull();
    expect(typeof app?.scrapeUrl).toBe('function');
  });

  it('refuses a private scrape target before the Firecrawl client is called', async () => {
    const scrapeSpy = vi.spyOn(FirecrawlApp.prototype, 'scrapeUrl');
    const app = createFirecrawlApp({ apiUrl: 'http://firecrawl:3002' });

    await expect(app?.scrapeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(
      UnsafeScrapeTargetError
    );
    expect(scrapeSpy).not.toHaveBeenCalled();
    scrapeSpy.mockRestore();
  });

  it('keeps a transient DNS failure retryable instead of a permanent refusal', async () => {
    dnsLookup.mockRejectedValueOnce(new Error('EAI_AGAIN'));
    const app = createFirecrawlApp({ apiUrl: 'http://firecrawl:3002' });

    // scrapeWithRetry only skips on UnsafeScrapeTargetError, so a DNS hiccup must not be one.
    const error = await app
      ?.scrapeUrl('https://flaky.example.com/doc')
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnsafeScrapeTargetError);
  });

  it('constructs a keyless app from a self-hosted apiUrl', () => {
    const app = createFirecrawlApp({ apiUrl: 'http://firecrawl:3002' });
    expect(app).not.toBeNull();
    expect(typeof app?.scrapeUrl).toBe('function');
  });
});

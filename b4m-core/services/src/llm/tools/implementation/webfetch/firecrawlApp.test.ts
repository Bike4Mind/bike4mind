import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import FirecrawlDefault from '@mendable/firecrawl-js';
import { FirecrawlApp, resolveFirecrawlApp, createFirecrawlApp, type FirecrawlScrapeParams } from './firecrawlApp';
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

  it('forwards scrapeUrl to the client with its params and returns its result', async () => {
    const params: FirecrawlScrapeParams = { formats: ['markdown'], timeout: 1 };
    const scraped = { markdown: '# hi', metadata: { title: 't' } };
    const scrapeSpy = vi.spyOn(FirecrawlApp.prototype, 'scrapeUrl').mockResolvedValue(scraped as never);
    const app = createFirecrawlApp({ apiUrl: 'http://firecrawl:3002' });

    const result = await app?.scrapeUrl('https://93.184.216.34/page', params);

    expect(scrapeSpy).toHaveBeenCalledWith('https://93.184.216.34/page', params);
    expect(result).toBe(scraped);
    scrapeSpy.mockRestore();
  });

  it('forwards search to the client', async () => {
    const found = { data: [{ url: 'https://example.com', title: 'Example' }] };
    const searchSpy = vi.spyOn(FirecrawlApp.prototype, 'search').mockResolvedValue(found as never);
    const app = createFirecrawlApp({ apiKey: 'test-key' });

    const result = await app?.search('some query');

    expect(searchSpy).toHaveBeenCalledWith('some query');
    expect(result).toBe(found);
    searchSpy.mockRestore();
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

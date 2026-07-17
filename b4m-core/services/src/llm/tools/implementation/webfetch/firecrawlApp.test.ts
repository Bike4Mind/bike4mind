import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import FirecrawlDefault from '@mendable/firecrawl-js';
import { FirecrawlApp, resolveFirecrawlApp, createFirecrawlApp } from './firecrawlApp';

const requireCjs = createRequire(import.meta.url);

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

  it('constructs a keyless app from a self-hosted apiUrl', () => {
    const app = createFirecrawlApp({ apiUrl: 'http://firecrawl:3002' });
    expect(app).not.toBeNull();
    expect(typeof app?.scrapeUrl).toBe('function');
  });
});

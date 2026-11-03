import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: {} }));

const { ArtifactViewRegistry, MAX_ARTIFACT_VIEWS, serveArtifactView, withTitle } = await import('./artifactViews');
const { SANDBOX_CSP } = await import('./sandboxProtocol');

describe('artifact views', () => {
  it('serves a registered artifact under the inline frame policy, sandboxed to an opaque origin', async () => {
    const registry = new ArtifactViewRegistry();
    const url = registry.add('Chart', '<!DOCTYPE html><html><body>hi</body></html>');

    const response = serveArtifactView(registry, url);

    expect(url).toMatch(/^b4m-artifact:\/\/view\/[0-9a-f-]{36}$/);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toBe(`${SANDBOX_CSP}; sandbox allow-scripts`);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('<!DOCTYPE html><title>Chart</title><html><body>hi</body></html>');
  });

  it('answers an unknown token, another host or another scheme with the inert not-found page', async () => {
    const registry = new ArtifactViewRegistry();
    registry.add('Chart', '<p>hi</p>');

    for (const url of [
      'b4m-artifact://view/00000000-0000-0000-0000-000000000000',
      'b4m-artifact://sandbox/',
      'https://view/whatever',
      'not a url',
    ]) {
      const response = serveArtifactView(registry, url);
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
      await expect(response.text()).resolves.toContain('no longer open here');
    }
  });

  it('keeps only the most recent artifacts', () => {
    const registry = new ArtifactViewRegistry();
    const urls = Array.from({ length: MAX_ARTIFACT_VIEWS + 1 }, (_, i) => registry.add(`A${i}`, `<p>${i}</p>`));

    expect(serveArtifactView(registry, urls[0]).status).toBe(404);
    expect(serveArtifactView(registry, urls[1]).status).toBe(200);
    expect(serveArtifactView(registry, urls[MAX_ARTIFACT_VIEWS]).status).toBe(200);
  });

  it('leaves a title the artifact already has, and escapes the one it adds', () => {
    expect(withTitle('<head><title>Own</title></head>', 'Card')).toBe('<head><title>Own</title></head>');
    expect(withTitle('<p>x</p>', '<b>&</b>')).toBe('<title>&lt;b&gt;&amp;&lt;/b&gt;</title><p>x</p>');
    expect(withTitle('<p>x</p>', '  ')).toBe('<title>Artifact</title><p>x</p>');
  });
});

import { describe, it, expect } from 'vitest';
import { renderBundleLoaderShell } from './renderBundleLoaderShell';

describe('renderBundleLoaderShell', () => {
  const shell = renderBundleLoaderShell();

  it('uses a sandbox="allow-scripts" iframe with NO allow-same-origin', () => {
    expect(shell).toContain('<iframe id="b4m-frame" sandbox="allow-scripts"');
    expect(shell).not.toContain('allow-same-origin'); // CRITICAL opaque-origin invariant
  });

  it('reads the localStorage JWT and re-fetches ?raw=1 with a Bearer header', () => {
    expect(shell).toContain("localStorage.getItem('access-token-storage')");
    expect(shell).toContain("'raw=1'");
    expect(shell).toContain("'Bearer '");
    expect(shell).toContain('Authorization');
    expect(shell).toContain("credentials: 'omit'"); // only credential is the explicit header
    expect(shell).toContain('frame.srcdoc = text'); // injects the fetched srcdoc
  });

  it('builds the login redirect at runtime and includes a noscript fallback', () => {
    expect(shell).toContain("'/login?redirectTo=' + encodeURIComponent");
    expect(shell).toContain('<noscript>');
  });

  it('noscript copy names the auth barrier, not a JS requirement', () => {
    // The loader shell is only served for GATED bundles - the barrier is authorization,
    // not client-side rendering. Prior copy said "requires JavaScript to view" and conflated
    // the two; agents (and humans) hitting a private share with JS off couldn't tell that
    // signing in was the fix.
    expect(shell).toContain('This is a private item');
    expect(shell).toContain('<a href="/login">Sign in</a>');
    expect(shell).not.toContain('requires JavaScript');
  });

  it('contains no external script source (only the inline bootstrap)', () => {
    expect(shell).not.toContain('<script src');
    expect(shell).not.toContain('<script type="module"');
  });

  it('handles 401/403 distinctly in the loader', () => {
    expect(shell).toContain('res.status === 401');
    expect(shell).toContain('res.status === 403');
  });

  // The shell must carry NO per-artifact data - the title would otherwise leak to an
  // anonymous viewer of a gated bundle. The page is fully static, so there is also no
  // interpolation/injection surface at all.
  it('uses a constant title and never interpolates artifact data', () => {
    // Title is brand-driven from APP_NAME with no brand fallback; unset in tests, so it
    // renders the neutral "Shared". Still carries NO per-artifact data.
    expect(shell).toContain('<title>Shared</title>');
    expect(shell).toContain('title="Shared"');
    // The function takes no arguments - there is no path for an artifact title to reach it.
    expect(renderBundleLoaderShell.length).toBe(0);
  });

  // Cold-start resilience: a freshly-deployed Lambda can 401/5xx on its first hit;
  // the loader retries with backoff before treating it as terminal.
  it('retries transient 401/5xx with backoff before giving up', () => {
    expect(shell).toContain('attempt < 4');
    expect(shell).toContain('setTimeout(load, attempt * 600)');
    expect(shell).toContain('res.status >= 500');
  });

  // Show "Loading..." and keep the iframe hidden until srcdoc lands, so a slow
  // round-trip doesn't look like a broken/blank page.
  it('shows a Loading placeholder and reveals the iframe only once srcdoc is set', () => {
    expect(shell).toContain('style="display:none"'); // iframe starts hidden
    expect(shell).toContain("note('Loading…')");
    expect(shell).toContain("frame.style.display = 'block'");
  });
});

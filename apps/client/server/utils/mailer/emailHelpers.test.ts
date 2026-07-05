import { describe, it, expect, afterEach } from 'vitest';
import { escapeHtmlAttr, buildEmailLogoImg } from './emailHelpers';

describe('escapeHtmlAttr', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeHtmlAttr('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('leaves a plain string untouched', () => {
    expect(escapeHtmlAttr('Acme AI')).toBe('Acme AI');
  });
});

describe('buildEmailLogoImg', () => {
  afterEach(() => {
    delete process.env.LOGO_URL;
  });

  it('returns an empty string when no logo URL is configured', () => {
    delete process.env.LOGO_URL;
    expect(buildEmailLogoImg('Acme')).toBe('');
    expect(buildEmailLogoImg('Acme', '')).toBe('');
  });

  it('builds an img with a branded, escaped alt when brand is set', () => {
    const html = buildEmailLogoImg('Acme & Co', 'https://cdn.example.com/logo.png');
    expect(html).toBe('<img src="https://cdn.example.com/logo.png" alt="Acme &amp; Co Logo" class="logo" />');
  });

  it('falls back to a generic "Logo" alt when brand is empty', () => {
    const html = buildEmailLogoImg('', 'https://cdn.example.com/logo.png');
    expect(html).toBe('<img src="https://cdn.example.com/logo.png" alt="Logo" class="logo" />');
  });

  it('defaults the logo URL to LOGO_URL when not passed', () => {
    process.env.LOGO_URL = 'https://cdn.example.com/env-logo.png';
    expect(buildEmailLogoImg('Acme')).toBe(
      '<img src="https://cdn.example.com/env-logo.png" alt="Acme Logo" class="logo" />'
    );
  });

  it('escapes a double-quote in the logo URL so the attribute stays well-formed', () => {
    const html = buildEmailLogoImg('Acme', 'https://x/logo.png?a="b"');
    expect(html).toContain('src="https://x/logo.png?a=&quot;b&quot;"');
  });
});

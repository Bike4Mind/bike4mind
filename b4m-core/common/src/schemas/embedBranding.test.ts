import { describe, expect, it } from 'vitest';
import {
  EMBED_BRANDING_DISPLAY_NAME_MAX,
  EMBED_BRANDING_LOGO_URL_MAX,
  EmbedBrandingSchema,
  parseBrandingColor,
  parseBrandingLogoUrl,
} from './embedBranding';

describe('EmbedBrandingSchema', () => {
  it('accepts a well-formed branding object', () => {
    const result = EmbedBrandingSchema.safeParse({
      primaryColor: '#336699',
      logoUrl: 'https://cdn.example.com/logo.png?v=2',
      displayName: 'Acme Support',
      hideBranding: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a 3-digit hex primaryColor', () => {
    expect(EmbedBrandingSchema.safeParse({ primaryColor: '#0a7' }).success).toBe(true);
  });

  it('accepts an empty object (all fields optional)', () => {
    expect(EmbedBrandingSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ['javascript: URL', 'javascript:alert(1)'],
    ['data: URL', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['http: URL', 'http://example.com/logo.png'],
    ['userinfo URL', 'https://user:pass@example.com/logo.png'],
    ['fragment URL', 'https://example.com/logo.png#frag'],
    ['bare-label host', 'https://localhost/logo.png'],
    ['relative path', '/logo.png'],
    ['not a URL', 'logo'],
  ])('rejects a %s logoUrl', (_label, logoUrl) => {
    expect(EmbedBrandingSchema.safeParse({ logoUrl }).success).toBe(false);
  });

  it('rejects a logoUrl over the length cap', () => {
    const logoUrl = 'https://example.com/' + 'a'.repeat(EMBED_BRANDING_LOGO_URL_MAX);
    expect(EmbedBrandingSchema.safeParse({ logoUrl }).success).toBe(false);
  });

  it.each([
    ['named color', 'red'],
    ['rgb() color', 'rgb(0,0,0)'],
    ['short hex', '#12'],
    ['non-hex digits', '#xyzxyz'],
    ['css breakout', '#fff;}body{background:url(//evil)'],
    ['8-digit hex', '#11223344'],
  ])('rejects a %s primaryColor', (_label, primaryColor) => {
    expect(EmbedBrandingSchema.safeParse({ primaryColor }).success).toBe(false);
  });

  it('rejects a displayName over the length cap', () => {
    const displayName = 'a'.repeat(EMBED_BRANDING_DISPLAY_NAME_MAX + 1);
    expect(EmbedBrandingSchema.safeParse({ displayName }).success).toBe(false);
  });

  it('rejects a whitespace-only displayName', () => {
    expect(EmbedBrandingSchema.safeParse({ displayName: '   ' }).success).toBe(false);
  });

  it('rejects a non-boolean hideBranding', () => {
    expect(EmbedBrandingSchema.safeParse({ hideBranding: 'true' }).success).toBe(false);
  });
});

describe('parseBrandingLogoUrl', () => {
  it('returns the canonical href for an https URL', () => {
    expect(parseBrandingLogoUrl(' https://cdn.example.com/logo.png ')).toBe('https://cdn.example.com/logo.png');
  });

  it('keeps an explicit port (must match the CSP origin the browser uses)', () => {
    expect(parseBrandingLogoUrl('https://cdn.example.com:8443/logo.png')).toBe(
      'https://cdn.example.com:8443/logo.png'
    );
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:image/png;base64,xx'],
    ['http://example.com/logo.png'],
    ['https://user:pass@example.com/logo.png'],
    ['https://example.com/logo.png#frag'],
    ['https://localhost/logo.png'],
    [''],
    ['   '],
  ])('returns null for %s', raw => {
    expect(parseBrandingLogoUrl(raw)).toBeNull();
  });

  it('returns null for a non-string', () => {
    expect(parseBrandingLogoUrl(undefined)).toBeNull();
  });
});

describe('parseBrandingColor', () => {
  it('returns canonical lowercase hex', () => {
    expect(parseBrandingColor(' #AABBCC ')).toBe('#aabbcc');
    expect(parseBrandingColor('#0A7')).toBe('#0a7');
  });

  it.each([['red'], ['rgb(0,0,0)'], ['#12'], ['#fff;}x{'], [''], ['   ']])('returns null for %s', raw => {
    expect(parseBrandingColor(raw)).toBeNull();
  });

  it('returns null for a non-string', () => {
    expect(parseBrandingColor(undefined)).toBeNull();
  });
});

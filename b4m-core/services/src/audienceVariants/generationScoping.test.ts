import { describe, it, expect } from 'vitest';
import {
  buildVariantGuidance,
  scrubInternalReferences,
  scrubVariantContent,
  isNoVariantContent,
  NO_VARIANT_CONTENT_SENTINEL,
  DEFAULT_INTERNAL_REFERENCE_RULES,
  PUBLIC_PRODUCT_NAME,
} from './generationScoping';
import { AUDIENCE_VARIANTS } from './variantRegistry';

const customer = AUDIENCE_VARIANTS.find(v => v.key === 'customer')!;
const internal = AUDIENCE_VARIANTS.find(v => v.key === 'internal')!;

describe('buildVariantGuidance', () => {
  it('adds the audience-exclusion clause only for the customer (least-privileged) variant', () => {
    const customerBlock = buildVariantGuidance(customer);
    const internalBlock = buildVariantGuidance(internal);

    expect(customerBlock).toContain('EXCLUDE');
    expect(customerBlock).toContain('External customers');
    expect(internalBlock).not.toContain('EXCLUDE');
    expect(internalBlock).toContain('All change types are in scope');
  });

  it('always includes the uncertainty rule and the empty-result sentinel', () => {
    for (const variant of AUDIENCE_VARIANTS) {
      const block = buildVariantGuidance(variant);
      expect(block).toContain('<variant_scope>');
      expect(block).toContain('</variant_scope>');
      expect(block).toContain('OMIT it');
      expect(block).toContain(NO_VARIANT_CONTENT_SENTINEL);
    }
  });
});

describe('scrubInternalReferences', () => {
  it('strips internal identifiers from customer text', () => {
    const out = scrubInternalReferences('Shipped from MillionOnMars/lumina5 today', customer);
    expect(out).not.toMatch(/MillionOnMars/i);
    expect(out).not.toMatch(/lumina5/i);
    expect(out).toContain(PUBLIC_PRODUCT_NAME);
  });

  it('is a no-op for the internal (privileged) variant', () => {
    const text = 'Internal: MillionOnMars/lumina5 refactor';
    expect(scrubInternalReferences(text, internal)).toBe(text);
  });

  it('applies the repo slug before the bare org token (most-specific-first)', () => {
    const out = scrubInternalReferences('MillionOnMars/lumina5', customer);
    // No half-rewritten "Bike4Mind/lumina5" left behind.
    expect(out).toBe(PUBLIC_PRODUCT_NAME);
  });

  it('handles empty input', () => {
    expect(scrubInternalReferences('', customer)).toBe('');
  });
});

describe('scrubVariantContent', () => {
  it('scrubs every string field of a customer variant, not just one body field', () => {
    const out = scrubVariantContent(
      { title: 'lumina5 update', subtitle: 'by MillionOnMars', description: 'see MillionOnMars/lumina5' },
      customer
    );
    expect(JSON.stringify(out)).not.toMatch(/MillionOnMars/i);
    expect(JSON.stringify(out)).not.toMatch(/lumina5/i);
  });

  it('passes non-string and null values through untouched', () => {
    const content = { title: 'MillionOnMars', subtitle: null, missing: undefined };
    const out = scrubVariantContent(content, customer);
    expect(out.subtitle).toBeNull();
    expect(out.missing).toBeUndefined();
    expect(out.title).toBe(PUBLIC_PRODUCT_NAME);
  });

  it('leaves the internal variant content untouched', () => {
    const content = { description: 'MillionOnMars/lumina5' };
    expect(scrubVariantContent(content, internal)).toEqual(content);
  });

  // Scrub-verification (the gate that keeps the write-side defense from rotting):
  // every known internal identifier must not survive into a customer variant.
  it('scrub-verification: no denylisted identifier survives into a customer variant', () => {
    const probes = ['MillionOnMars/lumina5', 'MillionOnMars', 'lumina5'];
    for (const probe of probes) {
      const out = scrubInternalReferences(`x ${probe} y`, customer);
      expect(out.toLowerCase()).not.toContain(probe.toLowerCase());
    }
  });
});

describe('isNoVariantContent', () => {
  it('matches the sentinel exactly after trim', () => {
    expect(isNoVariantContent(NO_VARIANT_CONTENT_SENTINEL)).toBe(true);
    expect(isNoVariantContent(`  ${NO_VARIANT_CONTENT_SENTINEL}\n`)).toBe(true);
  });

  it('does not match on substring (a real line mentioning the token is not the sentinel)', () => {
    expect(isNoVariantContent(`There are ${NO_VARIANT_CONTENT_SENTINEL} worth noting this week.`)).toBe(false);
  });

  it('treats blank/empty output as NOT the sentinel (caller treats blank as failure)', () => {
    expect(isNoVariantContent('')).toBe(false);
    expect(isNoVariantContent('   ')).toBe(false);
    expect(isNoVariantContent(null)).toBe(false);
    expect(isNoVariantContent(undefined)).toBe(false);
  });
});

// Guard against an empty rule list silently no-op'ing the security control.
describe('DEFAULT_INTERNAL_REFERENCE_RULES', () => {
  it('is non-empty', () => {
    expect(DEFAULT_INTERNAL_REFERENCE_RULES.length).toBeGreaterThan(0);
  });
});

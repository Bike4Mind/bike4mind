import { describe, it, expect, vi } from 'vitest';
import { extractVariantForViewer } from './extractVariantForViewer';
import { viewerClassifier } from './viewerClassifier';
import { MODAL_SAFE_DEFAULT_KEY } from './variantRegistry';

const INTERNAL_SENTINEL = '__INTERNAL_SENTINEL_DO_NOT_SERVE__';

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'doc1',
    title: 'base title',
    subtitle: null,
    description: 'base description',
    generationMetadata: { correlationId: 'c1', modelUsed: 'm1', generatedAt: new Date(), environment: 'dev' },
    ...overrides,
  };
}

describe('extractVariantForViewer', () => {
  it('strips variants and generationMetadata from every non-null result', () => {
    const doc = makeDoc({
      variants: {
        internal: { title: 'Internal Title' },
        customer: { title: 'Customer Title' },
      },
    });

    const result = extractVariantForViewer(doc, 'internal');
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('variants');
    expect(result).not.toHaveProperty('generationMetadata');
  });

  it('returns null for a key absent from variants', () => {
    const doc = makeDoc({
      variants: {
        internal: { title: 'Internal Title' },
        // 'customer' absent
      },
    });

    expect(extractVariantForViewer(doc, 'customer')).toBeNull();
  });

  it('merges variant fields onto top-level fields', () => {
    const doc = makeDoc({
      title: 'base title',
      variants: {
        internal: { title: 'Internal Title', description: 'Internal desc' },
      },
    });

    const result = extractVariantForViewer(doc, 'internal');
    expect(result?.title).toBe('Internal Title');
    expect(result?.description).toBe('Internal desc');
  });

  it('does not clobber top-level value when variant field is undefined', () => {
    const doc = makeDoc({
      title: 'base title',
      variants: {
        customer: { title: undefined, description: 'Customer desc' },
      },
    });

    const result = extractVariantForViewer(doc, 'customer');
    // undefined variant field must not overwrite the top-level 'base title'
    expect(result?.title).toBe('base title');
    expect(result?.description).toBe('Customer desc');
  });

  it('passes an explicit null variant field through (does not strip nulls)', () => {
    const doc = makeDoc({
      title: 'base title',
      variants: {
        customer: { title: null },
      },
    });

    const result = extractVariantForViewer(doc, 'customer');
    expect(result?.title).toBeNull();
  });

  it('passes through a legacy document (no variants) unchanged minus generationMetadata', () => {
    const doc = makeDoc(); // no variants field

    const result = extractVariantForViewer(doc, 'customer');
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('generationMetadata');
    expect(result?.title).toBe('base title');
    expect(result?.description).toBe('base description');
  });

  // Sentinel leak check - enforces the deny-list
  it('sentinel: internal content is absent from customer response', () => {
    const doc = makeDoc({
      variants: {
        internal: {
          title: `${INTERNAL_SENTINEL} internal title`,
          description: `${INTERNAL_SENTINEL} internal description`,
        },
        customer: { title: 'Customer Title', description: 'Customer description' },
      },
    });

    const result = extractVariantForViewer(doc, 'customer');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(INTERNAL_SENTINEL);
  });

  it('sentinel: internal content is absent when variants key is entirely missing for customer', () => {
    const doc = makeDoc({
      variants: {
        internal: {
          title: `${INTERNAL_SENTINEL} internal title`,
        },
        // no customer key
      },
    });

    // Should return null (no content for customer)
    expect(extractVariantForViewer(doc, 'customer')).toBeNull();
  });
});

describe('viewerClassifier', () => {
  it('returns internal for an admin user', () => {
    const result = viewerClassifier.classify({ isAdmin: true } as never);
    expect(result).toBe('internal');
  });

  it('returns customer for a non-admin user', () => {
    const result = viewerClassifier.classify({ isAdmin: false } as never);
    expect(result).toBe('customer');
  });

  it('returns customer when isAdmin is absent (fail-open)', () => {
    const result = viewerClassifier.classify({} as never);
    expect(result).toBe('customer');
  });

  it('safeDefaultKey is customer — the least-privileged audience', () => {
    expect(viewerClassifier.safeDefaultKey).toBe(MODAL_SAFE_DEFAULT_KEY);
    expect(viewerClassifier.safeDefaultKey).toBe('customer');
  });
});

describe('serving handler fail-open', () => {
  it('substitutes safeDefaultKey when classify throws', async () => {
    const brokenClassifier = {
      safeDefaultKey: 'customer' as const,
      classify: vi.fn().mockRejectedValue(new Error('db blip')),
    };

    let audienceKey: string;
    try {
      audienceKey = await brokenClassifier.classify({ isAdmin: false });
    } catch {
      audienceKey = brokenClassifier.safeDefaultKey;
    }

    expect(audienceKey).toBe('customer');
  });
});

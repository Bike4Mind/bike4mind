import { describe, it, expect } from 'vitest';
import { isProviderKeyFailure } from './providerKeyFailure';

const encode = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));

describe('isProviderKeyFailure', () => {
  it('recognizes a provider-key errorCode in a parsed JSON body', () => {
    expect(isProviderKeyFailure({ errorCode: 'provider_not_configured' })).toBe(true);
    expect(isProviderKeyFailure({ errorCode: 'provider_rejected' })).toBe(true);
  });

  it('recognizes it in an arraybuffer-typed error body', () => {
    const view = encode({ errorCode: 'provider_not_configured' });
    expect(isProviderKeyFailure(view.buffer)).toBe(true);
    expect(isProviderKeyFailure(Buffer.from(view))).toBe(true);
  });

  it('rejects other 401 bodies, binary or not', () => {
    expect(isProviderKeyFailure({ error: 'Unauthorized' })).toBe(false);
    expect(isProviderKeyFailure(encode({ error: 'Unauthorized' }).buffer)).toBe(false);
    expect(isProviderKeyFailure(new TextEncoder().encode('not json').buffer)).toBe(false);
    expect(isProviderKeyFailure(undefined)).toBe(false);
    expect(isProviderKeyFailure('provider_not_configured')).toBe(false);
  });
});
